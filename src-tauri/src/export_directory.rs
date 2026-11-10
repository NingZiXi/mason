use std::{collections::{HashMap, HashSet}, fs, io, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use serde::Serialize;

fn valid_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix)
            .map(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
            .unwrap_or(false));
    !name.is_empty() && name == name.trim() && name.len() <= 200
        && !name.ends_with('.') && !reserved
        && !name.chars().any(|c| c <= '\u{1f}' || "<>:\"/\\|?*".contains(c))
}

pub fn create(parent: &Path, name: &str) -> io::Result<PathBuf> {
    if !valid_name(name) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid export folder name"));
    }
    // create_dir is atomic: never reuse an existing directory, even if another
    // Mason instance is exporting to the same parent at the same time.
    for index in 1..=10000 {
        let folder = if index == 1 { name.to_owned() } else { format!("{name} ({index})") };
        let path = parent.join(folder);
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "Too many exports with this name"))
}

#[derive(Serialize)]
pub struct ExportTransaction {
    pub token: String,
    pub directory: String,
}

struct PendingExport {
    parent: PathBuf,
    staging: PathBuf,
    name: String,
    filenames: Vec<String>,
    destination: Option<PathBuf>,
    published: Vec<String>,
}

#[derive(Default)]
pub struct ExportTransactions {
    pending: HashMap<String, PendingExport>,
    next: u64,
}

static TRANSACTIONS: OnceLock<Mutex<ExportTransactions>> = OnceLock::new();

pub fn transactions() -> &'static Mutex<ExportTransactions> {
    TRANSACTIONS.get_or_init(|| Mutex::new(ExportTransactions::default()))
}

pub fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") { return format!(r"\\{unc}"); }
        if let Some(local) = path.strip_prefix(r"\\?\") { return local.into(); }
    }
    path.into_owned()
}

fn valid_filename(filename: &str) -> bool {
    let Some((stem, extension)) = filename.rsplit_once('.') else { return false; };
    matches!(extension, "stl" | "step")
        && matches!(stem, "jig_base" | "jig_pcb_insert" | "jig_top_cover" | "stencil_top" | "stencil_bottom")
}

/// Check both the lexical target and its resolved location before every file
/// operation. Cleanup never recursively deletes a directory or accepts a path
/// from the caller; only a live token can select the directories we created.
fn owned_directory(parent: &Path, directory: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(directory)?;
    if directory.parent() != Some(parent) || metadata.file_type().is_symlink()
        || !metadata.is_dir() || fs::canonicalize(directory)? != directory {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Export directory ownership check failed"));
    }
    Ok(())
}

impl ExportTransactions {
    pub fn begin(&mut self, parent: &Path, name: &str, filenames: Vec<String>) -> io::Result<ExportTransaction> {
        if !valid_name(name) || filenames.is_empty() || filenames.len() > 5
            || filenames.iter().any(|filename| !valid_filename(filename))
            || filenames.iter().collect::<HashSet<_>>().len() != filenames.len() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid export name or part filenames"));
        }
        let parent = fs::canonicalize(parent)?;
        if !parent.is_dir() {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, "Export parent is not a directory"));
        }
        loop {
            self.next += 1;
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?.as_nanos();
            let token = format!("{}-{timestamp}-{}", std::process::id(), self.next);
            let staging = parent.join(format!(".mason-export-{token}.tmp"));
            match fs::create_dir(&staging) {
                Ok(()) => {
                    self.pending.insert(token.clone(), PendingExport {
                        parent, staging: staging.clone(), name: name.into(), filenames,
                        destination: None, published: vec![],
                    });
                    return Ok(ExportTransaction { token, directory: staging.to_string_lossy().into_owned() });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }

    pub fn commit(&mut self, token: &str) -> io::Result<PathBuf> {
        let pending = self.pending.get_mut(token)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Unknown export transaction"))?;
        let destination = pending.commit()?;
        self.pending.remove(token);
        Ok(destination)
    }

    pub fn abort(&mut self, token: &str) -> io::Result<()> {
        // An already committed/aborted token has no deletion authority.
        let Some(pending) = self.pending.get(token) else { return Ok(()); };
        pending.cleanup()?;
        self.pending.remove(token);
        Ok(())
    }
}

impl PendingExport {
    fn commit(&mut self) -> io::Result<PathBuf> {
        if self.destination.is_some() {
            return Err(io::Error::other("This export commit failed earlier; abort it before retrying"));
        }
        owned_directory(&self.parent, &self.staging)?;
        let entries = fs::read_dir(&self.staging)?.collect::<Result<Vec<_>, _>>()?;
        if entries.len() != self.filenames.len() || entries.iter().any(|entry|
            !self.filenames.iter().any(|name| entry.file_name() == name.as_str())) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Export files are missing or unexpected"));
        }
        for filename in &self.filenames {
            let metadata = fs::symlink_metadata(self.staging.join(filename))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("Invalid or empty export file: {filename}")));
            }
        }

        // Reserving with create_dir cannot replace an existing empty folder,
        // unlike rename on Unix. No destination is visible during generation.
        let destination = create(&self.parent, &self.name)?;
        self.destination = Some(destination.clone());
        for filename in &self.filenames {
            owned_directory(&self.parent, &self.staging)?;
            owned_directory(&self.parent, &destination)?;
            let mut input = fs::File::open(self.staging.join(filename))?;
            let mut output = fs::OpenOptions::new().write(true).create_new(true)
                .open(destination.join(filename))?;
            // Register even a partial write so abort removes exactly our files.
            self.published.push(filename.clone());
            io::copy(&mut input, &mut output)?;
            output.sync_all()?;
        }
        remove_owned_files(&self.parent, &self.staging, &self.filenames)?;
        Ok(destination)
    }

    fn cleanup(&self) -> io::Result<()> {
        let mut first_error = None;
        if let Some(destination) = &self.destination {
            if let Err(error) = remove_owned_files(&self.parent, destination, &self.published) {
                first_error = Some(error);
            }
        }
        if let Err(error) = remove_owned_files(&self.parent, &self.staging, &self.filenames) {
            if first_error.is_none() { first_error = Some(error); }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn remove_owned_files(parent: &Path, directory: &Path, filenames: &[String]) -> io::Result<()> {
    match owned_directory(parent, directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        result => result?,
    }
    for filename in filenames {
        let path = directory.join(filename);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => fs::remove_file(path)?,
            Ok(_) => return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Unexpected file type in export cleanup")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(error) => return Err(error),
        }
    }
    // Nonrecursive removal preserves any unrelated file inserted into the dir.
    fs::remove_dir(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("mason-transaction-test-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            // Tests remove files and empty directories explicitly. Never use
            // recursive deletion on a computed filesystem path.
            let _ = fs::remove_dir(&self.0);
        }
    }
    fn files() -> Vec<String> { vec!["jig_base.stl".into(), "jig_pcb_insert.stl".into()] }

    #[test]
    fn rejects_unsafe_and_reserved_names() {
        for name in ["", ".", "..", "../outside", "a/b", "a\\b", "a:b", "CON", "nul.txt", "COM1", "LPT²", "CON .txt", "name.", " name", "a\n"] {
            assert!(!valid_name(name), "{name:?}");
        }
        assert!(!valid_name(&"板".repeat(70)));
        assert!(valid_name("控制板 v2.1"));
    }

    #[test]
    fn creates_numbered_folders_without_overwriting_existing_files() {
        let parent = std::env::temp_dir().join(format!("mason-export-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&parent).unwrap();
        let first = create(&parent, "控制板").unwrap();
        std::fs::write(first.join("jig_base.stl"), b"keep me").unwrap();
        std::fs::write(parent.join("控制板 (2)"), b"also keep me").unwrap();
        let next = create(&parent, "控制板").unwrap();
        assert_eq!(next, parent.join("控制板 (3)"));
        assert_eq!(std::fs::read(first.join("jig_base.stl")).unwrap(), b"keep me");
        assert_eq!(std::fs::read(parent.join("控制板 (2)")).unwrap(), b"also keep me");
        std::fs::remove_file(first.join("jig_base.stl")).unwrap();
        std::fs::remove_file(parent.join("控制板 (2)")).unwrap();
        std::fs::remove_dir(first).unwrap();
        std::fs::remove_dir(next).unwrap();
        std::fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn propagates_missing_parent_error() {
        assert!(create(Path::new("/mason-nonexistent-parent-for-export-test/child"), "board").is_err());
    }

    #[test]
    fn transaction_publishes_only_complete_exports_and_preserves_name_collisions() {
        let root = Sandbox::new();
        let mut manager = ExportTransactions::default();
        fs::create_dir(root.0.join("board")).unwrap();
        fs::write(root.0.join("board (2)"), b"unrelated").unwrap();
        let transaction = manager.begin(&root.0, "board", files()).unwrap();
        let staging = PathBuf::from(&transaction.directory);
        assert!(!root.0.join("board (3)").exists());
        for filename in files() { fs::write(staging.join(filename), b"completed model").unwrap(); }
        let final_dir = manager.commit(&transaction.token).unwrap();
        assert_eq!(final_dir, root.0.join("board (3)"));
        assert!(!staging.exists());
        // A stale token cannot remove the published export.
        manager.abort(&transaction.token).unwrap();
        for filename in files() {
            assert_eq!(fs::read(final_dir.join(&filename)).unwrap(), b"completed model");
            fs::remove_file(final_dir.join(filename)).unwrap();
        }
        assert_eq!(fs::read(root.0.join("board (2)" )).unwrap(), b"unrelated");
        fs::remove_file(root.0.join("board (2)")).unwrap();
        fs::remove_dir(root.0.join("board")).unwrap();
        fs::remove_dir(final_dir).unwrap();
    }

    #[test]
    fn missing_and_empty_parts_cannot_publish_and_abort_cleans_only_the_transaction() {
        let root = Sandbox::new();
        let mut manager = ExportTransactions::default();
        let transaction = manager.begin(&root.0, "board", files()).unwrap();
        let other = manager.begin(&root.0, "other", files()).unwrap();
        let staging = PathBuf::from(&transaction.directory);
        fs::write(staging.join("jig_base.stl"), b"first part").unwrap();
        assert!(manager.commit(&transaction.token).is_err());
        assert!(!root.0.join("board").exists());
        fs::write(staging.join("jig_pcb_insert.stl"), b"").unwrap();
        assert!(manager.commit(&transaction.token).is_err());
        manager.abort(&transaction.token).unwrap();
        assert!(!staging.exists());
        assert!(Path::new(&other.directory).is_dir());
        manager.abort(&other.token).unwrap();
    }

    #[test]
    fn rejects_unsafe_filenames_and_unknown_tokens() {
        let root = Sandbox::new();
        let mut manager = ExportTransactions::default();
        for filenames in [vec![], vec!["../outside.stl".into()], vec!["jig_base.stl".into(), "jig_base.stl".into()], vec!["jig_base.exe".into()]] {
            assert!(manager.begin(&root.0, "board", filenames).is_err());
        }
        assert!(manager.begin(&root.0, "../outside", files()).is_err());
        assert!(manager.commit("../outside").is_err());
        manager.abort("../outside").unwrap();
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn cleanup_preserves_unexpected_files_in_owned_staging_directory() {
        let root = Sandbox::new();
        let mut manager = ExportTransactions::default();
        let transaction = manager.begin(&root.0, "board", files()).unwrap();
        let staging = PathBuf::from(&transaction.directory);
        fs::write(staging.join("jig_base.stl"), b"partial").unwrap();
        fs::write(staging.join("keep.txt"), b"not ours").unwrap();
        assert!(manager.commit(&transaction.token).is_err());
        assert!(manager.abort(&transaction.token).is_err());
        assert_eq!(fs::read(staging.join("keep.txt")).unwrap(), b"not ours");
        assert!(!staging.join("jig_base.stl").exists());
        fs::remove_file(staging.join("keep.txt")).unwrap();
        manager.abort(&transaction.token).unwrap();
    }

    #[test]
    fn abort_rolls_back_partially_published_files_but_keeps_unrelated_destination_files() {
        let root = Sandbox::new();
        let mut manager = ExportTransactions::default();
        let transaction = manager.begin(&root.0, "board", files()).unwrap();
        let destination = create(&root.0, "board").unwrap();
        fs::write(destination.join("jig_base.stl"), b"partial copy").unwrap();
        fs::write(destination.join("keep.txt"), b"external file").unwrap();
        let pending = manager.pending.get_mut(&transaction.token).unwrap();
        pending.destination = Some(destination.clone());
        pending.published.push("jig_base.stl".into());
        assert!(manager.abort(&transaction.token).is_err());
        assert!(!destination.join("jig_base.stl").exists());
        assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"external file");
        assert!(!Path::new(&transaction.directory).exists());
        fs::remove_file(destination.join("keep.txt")).unwrap();
        manager.abort(&transaction.token).unwrap();
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_replaced_staging_symlink() {
        let root = Sandbox::new();
        let outside = Sandbox::new();
        fs::write(outside.0.join("jig_base.stl"), b"not ours").unwrap();
        let mut manager = ExportTransactions::default();
        let transaction = manager.begin(&root.0, "board", files()).unwrap();
        fs::remove_dir(&transaction.directory).unwrap();
        std::os::unix::fs::symlink(&outside.0, &transaction.directory).unwrap();
        assert!(manager.abort(&transaction.token).is_err());
        assert_eq!(fs::read(outside.0.join("jig_base.stl")).unwrap(), b"not ours");
        fs::remove_file(&transaction.directory).unwrap();
        manager.abort(&transaction.token).unwrap();
        fs::remove_file(outside.0.join("jig_base.stl")).unwrap();
    }
}
