//! Native menu: File (add, export, quit) and Help (about).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

const NOTICES_URL: &str = "https://github.com/JohnnnyTang/photo-way/blob/main/THIRD_PARTY_NOTICES.md";
static MENU_CHINESE: AtomicBool = AtomicBool::new(false);

pub fn about_text(version: &str, language: &str) -> String {
    let chinese = language == "zh-CN";
    [
        format!("Photo Way {version}"),
        if chinese { "将带位置信息的照片和视频制作成可在任意浏览器中打开的路线地图。" } else { "Turn geotagged photos and videos into a route map you can open in any browser." }.into(),
        String::new(),
        if chinese { "本软件采用 MIT 许可证。HEIC 支持使用 libheif 和 libde265（LGPL-3.0）；许可证及重新构建说明见 THIRD_PARTY_NOTICES。" } else { "MIT licensed. HEIC support uses libheif and libde265 (LGPL-3.0); their licences and rebuild instructions are in THIRD_PARTY_NOTICES." }.into(),
    ]
    .join(&char::from(10).to_string())
}

pub fn build<R: Runtime>(app: &AppHandle<R>, language: &str) -> tauri::Result<Menu<R>> {
    let chinese = language == "zh-CN";
    MENU_CHINESE.store(chinese, Ordering::Relaxed);
    let label = |en: &'static str, zh: &'static str| -> &'static str { if chinese { zh } else { en } };
    let add_files = MenuItemBuilder::with_id("add-files", label("Add photos...", "添加照片…"))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let add_folder = MenuItemBuilder::with_id("add-folder", label("Add folder...", "添加文件夹…"))
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let export = MenuItemBuilder::with_id("export", label("Export...", "导出…"))
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let about = MenuItemBuilder::with_id("about", label("About Photo Way", "关于 Photo Way")).build(app)?;

    let mut file = SubmenuBuilder::new(app, label("File", "文件"))
        .item(&add_files)
        .item(&add_folder)
        .separator()
        .item(&export);
    if cfg!(not(target_os = "macos")) {
        file = file
            .separator()
            .item(&MenuItemBuilder::with_id("quit", label("Quit", "退出")).build(app)?);
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, label("Edit", "编辑"))
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, label("Help", "帮助"))
        .item(&about)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        // macOS shows the first submenu under the application name.
        let app_menu = SubmenuBuilder::new(app, "Photo Way")
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(
                &MenuItemBuilder::with_id("quit", label("Quit Photo Way", "退出 Photo Way"))
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
    let chinese = MENU_CHINESE.load(Ordering::Relaxed);
    let language = if chinese { "zh-CN" } else { "en" };
    let handle = app.clone();
    app.dialog()
        .message(about_text(&version, language))
        .title(if chinese {
            "关于 Photo Way"
        } else {
            "About Photo Way"
        })
        .buttons(MessageDialogButtons::OkCancelCustom(
            (if chinese {
                "打开许可声明"
            } else {
                "Open notices"
            })
            .into(),
            (if chinese { "关闭" } else { "Close" }).into(),
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
        let t = about_text("1.2.3", "en");
        assert!(t.starts_with("Photo Way 1.2.3"));
        assert!(t.contains("libheif"));
        assert!(t.contains("THIRD_PARTY_NOTICES"));
        let zh = about_text("1.2.3", "zh-CN");
        assert!(zh.contains("路线地图"));
        assert!(zh.contains("libheif"));
    }
}
