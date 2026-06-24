
#[tauri::command]
pub(crate) async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}
