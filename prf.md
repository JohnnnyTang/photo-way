Desktop app (Tauri 2) over the frozen core API.

- Commands: scan, process, refresh_project (estimates), export, set_poster, open_in_browser, reveal, serve_start/stop, settings, cancel. Long work runs on a background thread; progress and results arrive as `pw-progress` / `pw-finished` events; cancel is a shared flag behind `Progress::cancelled`.
- Live preview: the real viewer in `preview` mode inside an iframe served by a `pw` custom scheme (`http://pw.localhost` on Windows, `pw://localhost` elsewhere). Media goes through `bundle::asset_for_ref` with Range support. The preview document carries its own CSP (blob workers, online tile hosts); the main window CSP is minimal.
- Video posters (D6): hidden `<video>` via the protocol, frame at about 0.5 s to canvas, JPEG to `media::set_poster`; timeout falls back to the placeholder tile.
- UI: drop zone and pickers, progress with Cancel, summary and skip report, options, export dialog with size estimate and a 50 MB single-HTML warning, Open / Reveal / Serve. Settings persist in the app config dir. Native menu (File, Edit, Help > About with libheif credit).
- `bundle::project` is still a stub on this branch: it panics, and the app turns that into an error message. `write`/`serve` Unimplemented errors are shown as messages.

Verified: viewer and app builds, app typecheck, fmt, clippy, workspace tests (17 new app tests), check-text, version-sync. Smoke-tested on Windows with `tauri dev` driven over WebView2 remote debugging: UI renders, scan reports skips, process fails gracefully on the stub, protocol serves viewer assets, and the real viewer mounted in the preview iframe with online tiles and workers (using a temporary local project file, since removed). Not tested: macOS, full export, video poster capture, serve (need Agent E and real media).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
