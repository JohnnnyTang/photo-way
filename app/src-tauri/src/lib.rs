//! Tauri shell: thin command layer over photoway-core. Owner: Wave 2 · F.

mod commands;
mod menu;
mod photos_import;
mod protocol;
mod settings;
mod summary;

use std::borrow::Cow;

use tauri::Manager;
use tauri::http::{Response, header};

use commands::AppState;

/// Answers a `pw` request on a worker thread (media reads must not block the UI thread).
fn respond(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    std::thread::spawn(move || {
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let snapshot = app.state::<AppState>().snapshot();
        let payload = protocol::handle(request.uri().path(), range.as_deref(), &snapshot);
        let mut builder = Response::builder()
            .status(payload.status)
            .header(header::CONTENT_TYPE, payload.mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            // The main window reads video frames from this scheme into a canvas (poster capture).
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        if let Some(range) = payload.content_range {
            builder = builder.header(header::CONTENT_RANGE, range);
        }
        if payload.mime.starts_with("text/html") {
            builder = builder.header("Content-Security-Policy", protocol::PREVIEW_CSP);
        }
        let response = builder
            .body(Cow::Owned(payload.body))
            .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())));
        responder.respond(response);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            respond(ctx.app_handle().clone(), request, responder);
        })
        .setup(|app| {
            let menu = menu::build(app.handle(), "en")?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::set_menu_language,
            commands::cancel,
            commands::reset,
            commands::scan,
            commands::import_photos,
            commands::open_photos,
            commands::set_poster,
            commands::process,
            commands::refresh_project,
            commands::export,
            commands::open_in_browser,
            commands::reveal,
            commands::serve_start,
            commands::serve_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Photo Way");
}
