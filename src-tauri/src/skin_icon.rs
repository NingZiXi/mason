//! Keep the native window and existing Windows shortcuts in sync with the chosen skin.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

static ICON_REVISION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IconSkin {
    Classic,
    Sakura,
}

impl IconSkin {
    fn rgba(self) -> &'static [u8] {
        match self {
            Self::Classic => include_bytes!("../icons/skin-classic.rgba"),
            Self::Sakura => include_bytes!("../icons/skin-sakura.rgba"),
        }
    }

    #[cfg(windows)]
    fn ico(self) -> &'static [u8] {
        match self {
            Self::Classic => include_bytes!("../icons/skin-classic.ico"),
            Self::Sakura => include_bytes!("../icons/skin-sakura.ico"),
        }
    }

    #[cfg(windows)]
    fn name(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Sakura => "sakura",
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconUpdate {
    windows_updated: usize,
    shortcuts_updated: usize,
    shortcuts_skipped: usize,
}

/// Shortcut maintenance is best effort: a user shortcut can be read-only.
/// The native window still receives its skin icon when no writable shortcut exists.
#[tauri::command]
pub async fn set_skin_icon(app: AppHandle, skin: IconSkin) -> Result<IconUpdate, String> {
    let revision = ICON_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
    let main_app = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        // Check on the UI thread, where icon writes execute in order. An outdated
        // command queued before a newer request must not restore the previous skin.
        let update = (|| -> Result<usize, String> {
            if ICON_REVISION.load(Ordering::SeqCst) != revision {
                return Ok(0);
            }
            let icon = tauri::image::Image::new_owned(skin.rgba().to_vec(), 128, 128);
            let mut updated = 0;
            for window in main_app.webview_windows().values() {
                window
                    .set_icon(icon.clone())
                    .map_err(|error| error.to_string())?;
                updated += 1;
            }
            Ok(updated)
        })();
        let _ = sender.send(update);
    })
    .map_err(|error| error.to_string())?;
    let mut result = IconUpdate {
        windows_updated: receiver.await.map_err(|error| error.to_string())??,
        ..IconUpdate::default()
    };

    #[cfg(windows)]
    {
        if let Ok(cache_dir) = app.path().app_local_data_dir() {
            let counts = tauri::async_runtime::spawn_blocking(move || {
                windows_shortcuts::update(skin, &cache_dir, revision)
            })
            .await
            .map_err(|error| error.to_string())?;
            match counts {
                Ok((updated, skipped)) => {
                    result.shortcuts_updated = updated;
                    result.shortcuts_skipped = skipped;
                }
                Err(error) => eprintln!("Could not update skin shortcut icons: {error}"),
            }
        }
    }

    Ok(result)
}

#[cfg(windows)]
mod windows_shortcuts {
    use super::{IconSkin, ICON_REVISION as REVISION};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Path, PathBuf, Prefix};
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    use windows::core::{Interface, GUID, PCWSTR};
    use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_RoamingAppData, IShellLinkW,
        SHChangeNotify, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, SHCNE_UPDATEITEM,
        SHCNF_PATHW, SLGP_RAWPATH,
    };

    static UPDATE_LOCK: Mutex<()> = Mutex::new(());

    struct ComApartment;

    impl ComApartment {
        fn new() -> Result<Self, String> {
            // All ShellLink objects live and are released on this blocking worker.
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| error.to_string())?;
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn same_windows_path(left: &Path, right: &Path) -> bool {
        let left: Vec<u16> = left.as_os_str().encode_wide().collect();
        let right: Vec<u16> = right.as_os_str().encode_wide().collect();
        // Compare native UTF-16 directly; lossy conversion can conflate distinct paths.
        unsafe { CompareStringOrdinal(&left, &right, true) == CSTR_EQUAL }
    }

    fn target_matches(executable: &Path, target: &Path) -> bool {
        if !target.is_absolute() {
            return false;
        }
        // Reject unrelated links before any filesystem access. In particular, a
        // local application never needs to probe another program's network target.
        let is_network = |path: &Path| {
            matches!(
                path.components().next(),
                Some(Component::Prefix(prefix))
                    if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
            )
        };
        if is_network(target) && !is_network(executable) {
            return false;
        }
        let (Some(executable_name), Some(target_name)) =
            (executable.file_name(), target.file_name())
        else {
            return false;
        };
        if !same_windows_path(Path::new(executable_name), Path::new(target_name)) {
            return false;
        }
        match (executable.canonicalize(), target.canonicalize()) {
            (Ok(executable), Ok(target)) => same_windows_path(&executable, &target),
            _ => false,
        }
    }

    fn known_folder(id: &GUID) -> Option<PathBuf> {
        unsafe {
            let value = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = PathBuf::from(OsString::from_wide(value.as_wide()));
            CoTaskMemFree(Some(value.0.cast()));
            Some(path)
        }
    }

    fn shortcut_folders() -> Vec<PathBuf> {
        let mut folders = Vec::new();
        // Shared shortcuts must not point at this account's private icon cache.
        if let Some(path) = known_folder(&FOLDERID_Desktop) {
            folders.push(path);
        }
        if let Some(roaming) = known_folder(&FOLDERID_RoamingAppData) {
            folders.push(roaming.join("Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar"));
        }
        folders
    }

    fn cached_icon(skin: IconSkin, cache_dir: &Path) -> Result<PathBuf, String> {
        let bytes = skin.ico();
        // Content-based names prevent Explorer from reusing an old icon after an update.
        let hash = bytes.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
        let directory = cache_dir.join("skin-icons");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join(format!("mason-{}-{hash:016x}.ico", skin.name()));
        if std::fs::read(&path).ok().as_deref() != Some(bytes) {
            std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        }
        Ok(path)
    }

    /// Returns true only if this exact executable's existing shortcut was changed.
    fn update_shortcut(
        shortcut: &Path,
        executable: &Path,
        icon: &Path,
        revision: u64,
    ) -> windows::core::Result<bool> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let file: IPersistFile = link.cast()?;
            let shortcut_wide = wide_path(shortcut);
            file.Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READWRITE)?;

            let mut target = vec![0_u16; 32768];
            // Never Resolve: it can search a network location or display Shell UI.
            link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
            let end = target
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(target.len());
            let target = PathBuf::from(OsString::from_wide(&target[..end]));
            if !target_matches(executable, &target) {
                return Ok(false);
            }

            let mut current_icon = vec![0_u16; 32768];
            let mut icon_index = 0;
            link.GetIconLocation(&mut current_icon, &mut icon_index)?;
            let end = current_icon
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(current_icon.len());
            let current_icon = PathBuf::from(OsString::from_wide(&current_icon[..end]));
            if icon_index == 0 && same_windows_path(&current_icon, icon) {
                return Ok(false);
            }
            if REVISION.load(Ordering::SeqCst) != revision {
                return Ok(false);
            }

            let icon_wide = wide_path(icon);
            link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)?;
            file.Save(PCWSTR(shortcut_wide.as_ptr()), true)?;
            SHChangeNotify(
                SHCNE_UPDATEITEM,
                SHCNF_PATHW,
                Some(shortcut_wide.as_ptr().cast()),
                None,
            );
            Ok(true)
        }
    }

    pub(super) fn update(
        skin: IconSkin,
        cache_dir: &Path,
        revision: u64,
    ) -> Result<(usize, usize), String> {
        let _lock = UPDATE_LOCK.lock().map_err(|error| error.to_string())?;
        if REVISION.load(Ordering::SeqCst) != revision {
            return Ok((0, 0));
        }
        let _apartment = ComApartment::new()?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let icon = cached_icon(skin, cache_dir)?;
        let mut updated = 0;
        let mut skipped = 0;
        for folder in shortcut_folders() {
            let Ok(entries) = std::fs::read_dir(folder) else {
                continue;
            };
            for entry in entries.flatten() {
                if REVISION.load(Ordering::SeqCst) != revision {
                    return Ok((updated, skipped));
                }
                let path = entry.path();
                let is_shortcut = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("lnk"));
                if !is_shortcut || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                match update_shortcut(&path, &executable, &icon, revision) {
                    Ok(true) => updated += 1,
                    Ok(false) => {}
                    // Inaccessible user links and malformed links are left intact.
                    Err(_) => skipped += 1,
                }
            }
        }
        Ok((updated, skipped))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn target_matching_requires_the_same_executable() {
            let root = std::env::temp_dir().join(format!("mason-icon-match-{}", std::process::id()));
            std::fs::create_dir_all(root.join("installed")).unwrap();
            std::fs::create_dir_all(root.join("debug")).unwrap();
            let installed = root.join("installed/mason.exe");
            let debug = root.join("debug/mason.exe");
            std::fs::write(&installed, b"installed").unwrap();
            std::fs::write(&debug, b"debug").unwrap();
            assert!(target_matches(&installed, &installed));
            assert!(!target_matches(&installed, &debug));
            assert!(!target_matches(&installed, &root.join("missing.exe")));
            assert!(!target_matches(&installed, Path::new("mason.exe")));
            assert!(!target_matches(&installed, Path::new(r"\\unavailable.invalid\share\mason.exe")));
            std::fs::remove_file(installed).unwrap();
            std::fs::remove_file(debug).unwrap();
            std::fs::remove_dir(root.join("installed")).unwrap();
            std::fs::remove_dir(root.join("debug")).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[test]
        fn windows_paths_compare_without_lossy_unicode_conversion() {
            assert!(same_windows_path(
                Path::new(r"C:\Mason\Mason.exe"),
                Path::new(r"c:\mason\mason.EXE")
            ));
            let first = PathBuf::from(OsString::from_wide(&[0xd800]));
            let second = PathBuf::from(OsString::from_wide(&[0xd801]));
            assert!(!same_windows_path(&first, &second));
        }

        #[test]
        fn only_matching_temporary_shortcuts_change_and_other_fields_are_preserved() {
            let _apartment = ComApartment::new().unwrap();
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "mason-icon-links-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&root).unwrap();
            let executable = root.join("mason.exe");
            let foreign_executable = root.join("other.exe");
            let icon = root.join("skin.ico");
            let matching_link = root.join("matching.lnk");
            let foreign_link = root.join("foreign.lnk");
            let malformed_link = root.join("malformed.lnk");
            std::fs::write(&executable, b"test executable").unwrap();
            std::fs::write(&foreign_executable, b"unrelated executable").unwrap();
            std::fs::write(&icon, IconSkin::Sakura.ico()).unwrap();
            std::fs::write(&malformed_link, b"not a shortcut").unwrap();

            // These links are confined to a new temporary directory, never the real Desktop.
            unsafe {
                for (path, target) in [
                    (&matching_link, &executable),
                    (&foreign_link, &foreign_executable),
                ] {
                    let link: IShellLinkW =
                        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                    let target_wide = wide_path(target);
                    let working_dir_wide = wide_path(&root);
                    link.SetPath(PCWSTR(target_wide.as_ptr())).unwrap();
                    link.SetArguments(windows::core::w!("--preserve-me")).unwrap();
                    link.SetWorkingDirectory(PCWSTR(working_dir_wide.as_ptr()))
                        .unwrap();
                    let file: IPersistFile = link.cast().unwrap();
                    let path_wide = wide_path(path);
                    file.Save(PCWSTR(path_wide.as_ptr()), true).unwrap();
                }
            }
            let foreign_before = std::fs::read(&foreign_link).unwrap();
            let revision = REVISION.load(Ordering::SeqCst);
            assert!(update_shortcut(&matching_link, &executable, &icon, revision).unwrap());
            assert!(!update_shortcut(&matching_link, &executable, &icon, revision).unwrap());
            assert!(!update_shortcut(&foreign_link, &executable, &icon, revision).unwrap());
            assert!(update_shortcut(&malformed_link, &executable, &icon, revision).is_err());
            assert_eq!(std::fs::read(&foreign_link).unwrap(), foreign_before);
            assert_eq!(std::fs::read(&malformed_link).unwrap(), b"not a shortcut");
            unsafe {
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                let file: IPersistFile = link.cast().unwrap();
                let path_wide = wide_path(&matching_link);
                file.Load(PCWSTR(path_wide.as_ptr()), STGM_READWRITE).unwrap();
                let mut arguments = [0_u16; 128];
                link.GetArguments(&mut arguments).unwrap();
                let end = arguments.iter().position(|value| *value == 0).unwrap();
                assert_eq!(String::from_utf16(&arguments[..end]).unwrap(), "--preserve-me");
                let mut directory = vec![0_u16; 32768];
                link.GetWorkingDirectory(&mut directory).unwrap();
                let end = directory.iter().position(|value| *value == 0).unwrap();
                assert!(same_windows_path(
                    &root,
                    &PathBuf::from(OsString::from_wide(&directory[..end]))
                ));
                let mut icon_path = vec![0_u16; 32768];
                let mut icon_index = -1;
                link.GetIconLocation(&mut icon_path, &mut icon_index).unwrap();
                let end = icon_path.iter().position(|value| *value == 0).unwrap();
                assert_eq!(icon_index, 0);
                assert!(same_windows_path(
                    &icon,
                    &PathBuf::from(OsString::from_wide(&icon_path[..end]))
                ));
            }
            for path in [
                executable,
                foreign_executable,
                icon,
                matching_link,
                foreign_link,
                malformed_link,
            ] {
                std::fs::remove_file(path).unwrap();
            }
            std::fs::remove_dir(root).unwrap();
        }
    }
}
