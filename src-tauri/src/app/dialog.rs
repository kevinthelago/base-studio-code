
#[tauri::command]
pub(crate) async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Native "save file" picker (#2027 P3, config-bundle export) — the chosen path, or `None` if
/// cancelled. Seeded with `default_name` + a JSON filter so the export lands with a sensible name.
#[tauri::command]
pub(crate) async fn pick_save_file(default_name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("JSON", &["json"])
            .save_file()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
}

/// Native "open file" picker (#2027 P3, config-bundle import) — the chosen path, or `None` if
/// cancelled.
#[tauri::command]
pub(crate) async fn pick_open_file() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new().add_filter("JSON", &["json"]).pick_file()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
}
