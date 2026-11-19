// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod export_directory;
mod error;
mod generation;
mod python_detect;
mod scad;
mod skin_icon;
#[cfg(windows)]
mod window_frame;

pub fn run() {
    let context = tauri::generate_context!();
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--check-bundled-engine")) {
        let result = tauri::utils::platform::resource_dir(context.package_info(), &tauri::utils::Env::default())
            .map_err(|e| e.to_string()).and_then(|root| {
                tauri::async_runtime::block_on(scad::check_packaged_engine(&root)).map_err(|e| e.to_string())
            });
        if let Err(err) = result { eprintln!("Bundled CAD engine failed: {err}"); std::process::exit(1); }
        return;
    }
    #[cfg(windows)]
    let context = window_frame::configure(context);
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.setup(|app| {
        window_frame::install(app);
        Ok(())
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_engine_status,
            commands::install_deps,
            commands::install_python,
            commands::set_python_path,
            commands::generate_stl,
            commands::cancel_generation,
            commands::part_metrics,
            commands::inspect_stencil,
            commands::validate_component_relief,
            commands::merge_component_relief,
            commands::export_stl,
            commands::read_dropped_file,
            commands::write_file_bytes,
            commands::begin_model_export,
            commands::commit_model_export,
            commands::abort_model_export,
            skin_icon::set_skin_icon,
        ])
        .run(context)
        .expect("error while running tauri application");
}
