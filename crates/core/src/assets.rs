//! Viewer build output compiled into the binary (`viewer/dist`, see `build.rs`).

pub const VIEWER_JS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../viewer/dist/viewer.js"
));
pub const VIEWER_CSS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../viewer/dist/viewer.css"
));
/// The page skeleton with the placeholders from `docs/DATA_CONTRACT.md` §2.3.
pub const TEMPLATE_HTML: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../viewer/dist/template.html"
));
/// Offline Natural Earth basemap (TopoJSON).
pub const BASEMAP_JSON: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../viewer/dist/world.topo.json"
));
