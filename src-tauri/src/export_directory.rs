use std::{io, path::{Path, PathBuf}};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
