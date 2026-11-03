//! Native file dialogs through rfd, which adds far less than tauri-plugin-dialog and its fs plugin.

use tauri::{AppHandle, Manager};

fn parent(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

pub async fn pick_folder(app: &AppHandle, title: Option<String>) -> Option<String> {
    let mut d = rfd::AsyncFileDialog::new().set_can_create_directories(true);
    if let Some(t) = title {
        d = d.set_title(t);
    }
    if let Some(w) = parent(app) {
        d = d.set_parent(&w);
    }
    d.pick_folder().await.map(|h| h.path().to_string_lossy().into_owned())
}

pub async fn save_file(app: &AppHandle, suggested: &str, filters: Vec<(String, Vec<String>)>) -> Option<String> {
    let mut d = rfd::AsyncFileDialog::new().set_file_name(suggested).set_can_create_directories(true);
    for (name, exts) in &filters {
        d = d.add_filter(name, exts);
    }
    if let Some(w) = parent(app) {
        d = d.set_parent(&w);
    }
    d.save_file().await.map(|h| h.path().to_string_lossy().into_owned())
}
