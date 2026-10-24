//! Remembered settings: a small JSON file in the app config directory.

use std::path::{Path, PathBuf};

use photoway_core::bundle::ExportOptions;
use photoway_core::media::{FullSize, MediaOptions, WEB_EDGE_RANGE};
use photoway_core::model::{Basemap, ProjectOptions};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "settings.json";
const THEMES: &[&str] = &["auto", "light", "dark", "dusk", "paper", "forest"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub title: String,
    /// `none`, `web` or `original`.
    pub full: String,
    pub web_edge: u32,
    pub include_video: bool,
    pub strip_exif: bool,
    /// `None` keeps full coordinate precision.
    pub coord_decimals: Option<u8>,
    /// A `Basemap` id in kebab-case.
    pub basemap: String,
    pub theme: String,
    /// `html`, `dir` or `zip`.
    pub format: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            title: "My trip".into(),
            full: "web".into(),
            web_edge: 2048,
            include_video: true,
            strip_exif: true,
            coord_decimals: None,
            basemap: "auto".into(),
            theme: "auto".into(),
            format: "html".into(),
        }
    }
}

impl Settings {
    pub fn full_size(&self) -> FullSize {
        match self.full.as_str() {
            "none" => FullSize::None,
            "original" => FullSize::Original,
            _ => FullSize::Web,
        }
    }

    pub fn basemap_id(&self) -> Basemap {
        serde_json::from_value(serde_json::Value::String(self.basemap.clone())).unwrap_or_default()
    }

    pub fn media_options(&self, cache_dir: Option<PathBuf>) -> MediaOptions {
        MediaOptions {
            full: self.full_size(),
            web_long_edge: self.web_edge.clamp(WEB_EDGE_RANGE.0, WEB_EDGE_RANGE.1),
            include_video: self.include_video,
            cache_dir,
        }
    }

    pub fn export_options(&self) -> ExportOptions {
        let theme = if THEMES.contains(&self.theme.as_str()) {
            self.theme.clone()
        } else {
            "auto".into()
        };
        let title = self.title.trim();
        ExportOptions {
            title: if title.is_empty() {
                "Photo Way".into()
            } else {
                title.into()
            },
            options: ProjectOptions {
                theme,
                basemap: self.basemap_id(),
                ..ProjectOptions::default()
            },
            coord_decimals: self.coord_decimals.map(|d| d.min(10)),
            strip_exif: self.strip_exif,
        }
    }
}

/// Missing or corrupt files fall back to the defaults.
pub fn load(dir: &Path) -> Settings {
    std::fs::read(dir.join(FILE_NAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(tmp, dir.join(FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            title: "Baikal".into(),
            full: "original".into(),
            coord_decimals: Some(3),
            theme: "dusk".into(),
            ..Settings::default()
        };
        save(dir.path(), &s).unwrap();
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn missing_corrupt_and_partial_files_fall_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        std::fs::write(dir.path().join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(load(dir.path()), Settings::default());
        std::fs::write(dir.path().join(FILE_NAME), br#"{"title":"T"}"#).unwrap();
        let s = load(dir.path());
        assert_eq!(s.title, "T");
        assert_eq!(s.web_edge, 2048);
        assert!(s.strip_exif);
    }

    #[test]
    fn maps_to_core_options_defensively() {
        let s = Settings {
            web_edge: 99_999,
            title: "  ".into(),
            theme: "neon".into(),
            basemap: "satellite-labels".into(),
            coord_decimals: Some(200),
            ..Settings::default()
        };
        assert_eq!(s.media_options(None).web_long_edge, WEB_EDGE_RANGE.1);
        let e = s.export_options();
        assert_eq!(e.title, "Photo Way");
        assert_eq!(e.options.theme, "auto");
        assert_eq!(e.options.basemap, Basemap::SatelliteLabels);
        assert_eq!(e.coord_decimals, Some(10));
        let bad = Settings {
            basemap: "nope".into(),
            ..Settings::default()
        };
        assert_eq!(bad.basemap_id(), Basemap::Auto);
    }
}
