//! 多策略探测 Python 可执行文件
//!
//! Python 是夹具生成的 CAD 引擎(通过 python/jig_generator.py)
use std::path::Path;
use std::process::Command;

/// AppRun exports PYTHONHOME=$APPDIR/usr and adds usr/share/pyshared to
/// PYTHONPATH. Neither is the home of Mason's Python (or an external venv).
/// Only change the child process; GTK/WebKit still need the launcher environment.
pub fn python_command(exe: &str) -> Command {
    let mut cmd = Command::new(exe);
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var_os("APPDIR").filter(|v| !v.is_empty()) {
        clean_appimage_env(&mut cmd, Path::new(&appdir));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[cfg(any(target_os = "linux", test))]
fn clean_appimage_env(cmd: &mut Command, appdir: &Path) {
    cmd.env_remove("PYTHONHOME").env_remove("PYTHONPATH");
    // External interpreters must still see packages installed in the user site.
    if Path::new(cmd.get_program()).starts_with(appdir) {
        cmd.env("PYTHONNOUSERSITE", "1");
    }
}

#[cfg(target_os = "windows")]
const PYTHON_PATHS: &[&str] = &[
    "C:/Espressif/tools/python/python.exe",
    "C:/Python311/python.exe",
    "C:/Python312/python.exe",
    "C:/Python313/python.exe",
    "C:/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe",
    "C:/Program Files/Python311/python.exe",
];

/// 扫描 %LOCALAPPDATA%\Programs\Python\Python3XX\(winget / 官网安装器默认位置)
/// 返回最高版本的 python.exe
#[cfg(target_os = "windows")]
pub fn find_python_in_localappdata() -> Option<String> {
    let la = std::env::var("LOCALAPPDATA").ok()?;
    let base = Path::new(&la).join("Programs").join("Python");
    let mut best: Option<(u32, String)> = None;
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(ver) = name.strip_prefix("Python3") {
                if let Ok(v) = ver.parse::<u32>() {
                    let exe = e.path().join("python.exe");
                    if exe.exists() {
                        if best.as_ref().map_or(true, |(bv, _)| v > *bv) {
                            best = Some((v, exe.to_string_lossy().into_owned()));
                        }
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(target_os = "macos")]
const PYTHON_PATHS: &[&str] = &[
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
];

#[cfg(all(unix, not(target_os = "macos")))]
const PYTHON_PATHS: &[&str] = &[
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/python/bin/python3",
];

/// 通过系统 PATH 查找 Python
/// Windows: 用 `where`(返回 C:\... 原 原路径)
/// Unix: 用 `which`(返回 /usr/bin/... 原 原路径)
pub fn find_python_in_path() -> Option<String> {
    let lookup = if cfg!(target_os = "windows") { "where" } else { "which" };

    for cmd in &["python", "python3", "py"] {
        if let Ok(output) = Command::new(lookup).arg(cmd).output() {
            if !output.status.success() {
                continue;
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let raw = line.trim();
                if raw.is_empty() {
                    continue;
                }
                // Git Bash 风格转 Windows 原生路径: /c/Espressif/... → C:\Espressif\...
                let path_str = normalize_path(raw);
                if !path_str.is_empty() && Path::new(&path_str).exists() {
                    return Some(path_str);
                }
            }
        }
    }
    None
}

/// 路径归化(公开函数)
/// - /c/Espressif/... → C:\Espressif\...
/// - /usr/bin/python3 → /usr/bin/python3 (Unix 原样)
/// - C:\Path\... → C:\Path\... (Windows 原样)
pub fn normalize_path(p: &str) -> String {
    // Git Bash 风格:/X/... 其中 X 是单个字母
    if cfg!(target_os = "windows") && p.starts_with('/') && p.len() > 2 {
        let chars: Vec<char> = p.chars().collect();
        if chars.len() >= 3 && chars[2] == '/' {
            let drive = chars[1].to_ascii_uppercase();
            let rest = &p[3..];
            // 把 / 转成 \
            let rest_win = rest.replace('/', "\\");
            return format!("{}:\\{}", drive, rest_win);
        }
    }
    p.to_string()
}

/// 在常见安装位置查找 Python(含 %LOCALAPPDATA% winget/官网安装器位置)
pub fn find_python_in_standard_paths() -> Option<String> {
    for path in PYTHON_PATHS {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = find_python_in_localappdata() {
            return Some(p);
        }
    }
    None
}

/// 综合探测 Python
pub fn detect_python() -> Option<String> {
    find_python_in_path().or_else(find_python_in_standard_paths)
}
#[cfg(test)]
mod appimage_tests {
    use super::*;

    #[test]
    fn appimage_child_can_load_stdlib_without_gui_python_paths() {
        let python = find_python_in_path().expect("Python on test host");
        let appdir = Path::new(&python).parent().unwrap();
        for (root, bundled) in [(appdir.to_owned(), true), (appdir.join("other-app"), false)] {
            let mut cmd = Command::new(&python);
            cmd.env("PYTHONHOME", root.join("usr")).env("PYTHONPATH", root.join("usr/share/pyshared"))
                .env_remove("PYTHONNOUSERSITE");
            clean_appimage_env(&mut cmd, &root);
            let check = "import encodings, os; assert 'PYTHONHOME' not in os.environ and 'PYTHONPATH' not in os.environ; print(os.getenv('PYTHONNOUSERSITE', 'external'))";
            let result = cmd.args(["-c", check]).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), if bundled { "1" } else { "external" });
        }
    }
}
