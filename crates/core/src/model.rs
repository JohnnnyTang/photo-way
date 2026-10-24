//! Project document — the Rust mirror of `docs/DATA_CONTRACT.md` (v1).
//!
//! Field names and JSON shapes are frozen; change them only together with the
//! schema (`schema/photoway.v1.schema.json`) and `viewer/src/model.ts`.

use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "photoway";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format: String,
    pub version: u32,
    /// Unique per export; keys the viewer's localStorage.
    pub id: String,
    pub title: String,
    pub generator: String,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
    pub options: ProjectOptions,
    /// Sorted by `ts` ascending (nulls last); `items[i].id == i`.
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOptions {
    pub theme: String,
    pub basemap: Basemap,
    pub outlier_speed_kmh: f64,
}

impl Default for ProjectOptions {
    fn default() -> Self {
        Self {
            theme: "auto".into(),
            basemap: Basemap::Auto,
            outlier_speed_kmh: 300.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Basemap {
    #[default]
    Auto,
    Offline,
    Satellite,
    SatelliteLabels,
    Topo,
    Osm,
    Terrain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Photo,
    Video,
    /// Still image paired with a short motion clip (iPhone Live Photo).
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TsSource {
    /// DateTimeOriginal + OffsetTimeOriginal.
    Offset,
    /// GPS date/time stamp (UTC).
    Gps,
    /// Local time without a zone, treated as UTC.
    Naive,
    /// File modification time.
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u32,
    pub kind: Kind,
    pub name: String,
    /// ISO-8601 as written by the camera, with offset when known.
    pub time: Option<String>,
    /// UTC epoch milliseconds.
    pub ts: Option<i64>,
    pub ts_source: Option<TsSource>,
    /// Local calendar date `YYYY-MM-DD`.
    pub day: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub alt: Option<f64>,
    /// Display dimensions after EXIF orientation.
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub dur: Option<f64>,
    pub thumb: Ref,
    #[serde(default)]
    pub full: Option<Ref>,
    #[serde(default)]
    pub video: Option<Ref>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<String>,
}

/// A relative URL (`thumbs/00012.jpg`) or a pack ref (`#pack:thumbs:<offset>:<len>`).
pub type Ref = String;

pub fn pack_ref(pack: &str, offset: u64, len: u64) -> Ref {
    format!("#pack:{pack}:{offset}:{len}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_round_trips_with_contract_field_names() {
        let json = r##"{"id":0,"kind":"live","name":"IMG_0001.HEIC","time":"2026-07-23T10:32:15+08:00",
            "ts":1784773935000,"tsSource":"offset","day":"2026-07-23","lat":53.1,"lon":108.2,
            "alt":null,"w":3024,"h":4032,"dur":2.9,"thumb":"#pack:thumbs:0:12000","full":null,"video":null}"##;
        let item: Item = serde_json::from_str(json).unwrap();
        assert_eq!(item.kind, Kind::Live);
        assert_eq!(item.ts_source, Some(TsSource::Offset));
        let back = serde_json::to_value(&item).unwrap();
        assert_eq!(back["tsSource"], "offset");
        assert!(back.get("flags").is_none());
    }

    #[test]
    fn basemap_uses_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Basemap::SatelliteLabels).unwrap(),
            "\"satellite-labels\""
        );
    }
}
