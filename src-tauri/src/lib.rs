// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod python_detect;
mod scad;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_engine_status,
            commands::install_deps,
            commands::install_python,
            commands::set_python_path,
            commands::generate_stl,
            commands::part_metrics,
            commands::export_stl,
            commands::save_project,
            commands::load_project,
            commands::read_dropped_file,
            commands::write_file_bytes,
            commands::ensure_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}