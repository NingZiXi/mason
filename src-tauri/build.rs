use std::path::Path;

fn main() {
    sync_jig_generator();
    tauri_build::build();
}

/// 单一来源:python/jig_generator.py 是唯一权威副本。
/// 打包所需的 resources/scripts/jig_generator.py 在构建时由此自动同步,
/// 避免两份手工维护出现内容分歧(历史上曾导致 resources 副本落后于 dev)。
fn sync_jig_generator() {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is required to bundle the Python engine");
    let src = Path::new(&manifest_dir)
        .parent()
        .expect("The Tauri crate must be inside the project directory")
        .join("python").join("jig_generator.py");
    // This source lives outside the crate. Tauri watches the resource copy,
    // but only watching that copy misses Python-only incremental changes.
    println!("cargo:rerun-if-changed={}", src.display());
    let source = std::fs::read(&src)
        .unwrap_or_else(|error| panic!("Cannot read Python engine {}: {error}", src.display()));
    let dst_dir = Path::new(&manifest_dir).join("resources").join("scripts");
    let dst = dst_dir.join("jig_generator.py");
    // 内容一致则跳过,避免无谓的磁盘写入与 mtime 抖动
    if std::fs::read(&dst).is_ok_and(|existing| existing == source) {
        return;
    }
    // A failed sync must stop packaging, rather than ship an old engine.
    std::fs::create_dir_all(&dst_dir)
        .unwrap_or_else(|error| panic!("Cannot create Python resource directory {}: {error}", dst_dir.display()));
    std::fs::write(&dst, &source)
        .unwrap_or_else(|error| panic!("Cannot sync Python engine to {}: {error}", dst.display()));
    let bundled = std::fs::read(&dst)
        .unwrap_or_else(|error| panic!("Cannot verify bundled Python engine {}: {error}", dst.display()));
    assert_eq!(source, bundled, "Bundled Python engine differs from its source");
}
