//! The native menu, same layout as Electron's. Item ids carry the command to the renderer.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::project::{load_recent, RecentEntry};
use crate::Ctx;

const RECENT_PREFIX: &str = "recent:";

fn build<R: Runtime>(app: &AppHandle<R>, recent: &[RecentEntry]) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let mut open_recent = SubmenuBuilder::new(app, "Open Recent");
    if recent.is_empty() {
        open_recent = open_recent.item(&MenuItemBuilder::new("No Recent Projects").enabled(false).build(app)?);
    } else {
        for (i, r) in recent.iter().enumerate() {
            open_recent = open_recent.item(&MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{i}"), &r.name).build(app)?);
        }
    }

    let export = SubmenuBuilder::new(app, "Export")
        .item(&item("export:video", "Video (MP4)\u{2026}", Some("CmdOrCtrl+E"))?)
        .item(&item("export:fcpxml", "FCPXML (Resolve/FCP)\u{2026}", None)?)
        .item(&item("export:xmeml", "XMEML (Premiere)\u{2026}", None)?)
        .item(&item("export:srt", "Captions (SRT)\u{2026}", None)?)
        .item(&item("export:vtt", "Captions (VTT)\u{2026}", None)?)
        .build()?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open\u{2026}", Some("CmdOrCtrl+O"))?)
        .item(&open_recent.build()?)
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Save As\u{2026}", Some("CmdOrCtrl+Shift+S"))?)
        .item(&export);
    if !cfg!(target_os = "macos") {
        file = file.separator().item(&PredefinedMenuItem::quit(app, None)?);
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View").item(&item("view:reload", "Reload", Some("CmdOrCtrl+R"))?).separator().item(&PredefinedMenuItem::fullscreen(app, None)?).build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?).build()?;

    let mut bar = MenuBuilder::new(app);
    // macOS shows the first submenu as the app menu, which would hide "File" under the app's name.
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Frontstage").about(None).separator().hide().hide_others().show_all().separator().quit().build()?;
        bar = bar.item(&app_menu);
    }
    bar.item(&file).item(&edit).item(&view).item(&window).build()
}

pub fn rebuild<R: Runtime>(app: &AppHandle<R>) {
    let ctx = app.state::<Ctx>();
    let recent = load_recent(&ctx.user_data);
    match build(app, &recent) {
        Ok(menu) => {
            let _ = app.set_menu(menu);
        }
        Err(e) => eprintln!("[menu] {e}"),
    }
}

/// What a menu id sends to the renderer: (command, arg).
pub fn command_for(id: &str, recent: &[RecentEntry]) -> Option<(String, serde_json::Value)> {
    use serde_json::{json, Value};
    if let Some(kind) = id.strip_prefix("export:") {
        return Some(("export".into(), json!(kind)));
    }
    if let Some(i) = id.strip_prefix(RECENT_PREFIX) {
        let r = recent.get(i.parse::<usize>().ok()?)?;
        return Some(("open-recent".into(), serde_json::to_value(r).ok()?));
    }
    matches!(id, "new" | "open" | "save" | "save-as").then(|| (id.to_string(), Value::Null))
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == "view:reload" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval("location.reload()");
        }
        return;
    }
    let ctx = app.state::<Ctx>();
    if let Some((cmd, arg)) = command_for(id, &load_recent(&ctx.user_data)) {
        let _ = app.emit_to("main", "menu:command", serde_json::json!({ "command": cmd, "arg": arg }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn menu_ids_map_to_the_same_commands_as_electron() {
        for id in ["new", "open", "save", "save-as"] {
            assert_eq!(command_for(id, &[]), Some((id.to_string(), Value::Null)));
        }
        for kind in ["video", "fcpxml", "xmeml", "srt", "vtt"] {
            assert_eq!(command_for(&format!("export:{kind}"), &[]), Some(("export".to_string(), json!(kind))));
        }
        let r = RecentEntry { id: "i".into(), name: "n".into(), path: "/p".into() };
        assert_eq!(command_for("recent:0", std::slice::from_ref(&r)), Some(("open-recent".to_string(), json!({ "id": "i", "name": "n", "path": "/p" }))));
        assert_eq!(command_for("recent:1", &[r]), None);
        assert_eq!(command_for("view:reload", &[]), None);
        assert_eq!(command_for("nope", &[]), None);
    }
}
