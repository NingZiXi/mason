use std::path::Path;

fn main() {
    sync_jig_generator();
    tauri_build::build();
}

/// 单一来源:python/jig_generator.py 是唯一权威副本。
/// 打包所需的 resources/scripts/jig_generator.py 在构建时由此自动同步,
/// 避免两份手工维护出现内容分歧(历史上曾导致 resources 副本落后于 dev)。
fn sync_jig_generator() {
    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(d) => d,
        Err(_) => return,
    };
    let src = Path::new(&manifest_dir)
        .parent()
        .map(|p| p.join("python").join("jig_generator.py"));
    let Some(src) = src else { return };
    if !src.exists() {
        return;
    }
    let dst_dir = Path::new(&manifest_dir).join("resources").join("scripts");
    let dst = dst_dir.join("jig_generator.py");
    // 内容一致则跳过,避免无谓的磁盘写入与 mtime 抖动
    if dst.exists() {
        if let (Ok(a), Ok(b)) = (std::fs::read(&src), std::fs::read(&dst)) {
            if a == b {
                return;
            }
        }
    }
    if let Err(e) = std::fs::create_dir_all(&dst_dir) {
        eprintln!("cargo:warning=创建 scripts 目录失败: {e}");
        return;
    }
    if let Err(e) = std::fs::copy(&src, &dst) {
        eprintln!("cargo:warning=同步 jig_generator.py 失败: {e}");
    }
}