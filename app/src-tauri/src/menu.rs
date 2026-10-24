//! Native menu: File (add, export, quit) and Help (about).

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

const NOTICES_URL: &str = "https://github.com/JohnnnyTang/photo-way/blob/main/THIRD_PARTY_NOTICES.md";

pub fn about_text(version: &str) -> String {
    [
        format!("Photo Way {version}"),
        "Turn geotagged photos and videos into a route map you can open in any browser.".into(),
        String::new(),
        "MIT licensed. HEIC support uses libheif and libde265 (LGPL-3.0); their licences and \
         rebuild instructions are in THIRD_PARTY_NOTICES."
            .into(),
    ]
    .join(&char::from(10).to_string())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let add_files = MenuItemBuilder::with_id("add-files", "Add photos...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let add_folder = MenuItemBuilder::with_id("add-folder", "Add folder...")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let export = MenuItemBuilder::with_id("export", "Export...")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let about = MenuItemBuilder::with_id("about", "About Photo Way").build(app)?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&add_files)
        .item(&add_folder)
        .separator()
        .item(&export);
    if cfg!(not(target_os = "macos")) {
        file = file
            .separator()
            .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?);
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help").item(&about).build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        // macOS shows the first submenu under the application name.
        let app_menu = SubmenuBuilder::new(app, "Photo Way")
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(
                &MenuItemBuilder::with_id("quit", "Quit Photo Way")
                    .accelerator("Cmd+Q")
                    .build(app)?,
            )
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&help).build()
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        id @ ("add-files" | "add-folder" | "export") => {
            // The webview owns pickers and the export dialog.
            let _ = app.emit("pw-menu", id);
        }
        "about" => show_about(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

fn show_about<R: Runtime>(app: &AppHandle<R>) {
    let version = app.package_info().version.to_string();
    let handle = app.clone();
    app.dialog()
        .message(about_text(&version))
        .title("About Photo Way")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open notices".into(),
            "Close".into(),
        ))
        .show(move |open_notices| {
            if !open_notices {
                return;
            }
            let bundled = handle
                .path()
                .resolve("THIRD_PARTY_NOTICES.md", tauri::path::BaseDirectory::Resource)
                .ok()
                .filter(|p| p.exists());
            let _ = match bundled {
                Some(p) => handle.opener().open_path(p.to_string_lossy(), None::<&str>),
                None => handle.opener().open_url(NOTICES_URL, None::<&str>),
            };
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_mentions_version_and_libheif_credit() {
        let t = about_text("1.2.3");
        assert!(t.starts_with("Photo Way 1.2.3"));
        assert!(t.contains("libheif"));
        assert!(t.contains("THIRD_PARTY_NOTICES"));
    }
}
