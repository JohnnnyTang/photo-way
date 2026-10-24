//! Read location, capture time and dimensions from photos and videos. Owner: Wave 1 · A.

use std::path::Path;

use crate::model::{Kind, TsSource};
use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub kind: Kind,
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
    /// Capture time as ISO-8601 (with offset when known).
    pub time: Option<String>,
    /// UTC epoch milliseconds.
    pub ts: Option<i64>,
    pub ts_source: Option<TsSource>,
    /// Local calendar date `YYYY-MM-DD`.
    pub day: Option<String>,
    /// Display dimensions after orientation.
    pub w: u32,
    pub h: u32,
    /// EXIF orientation 1–8 (1 when unknown).
    pub orientation: u8,
    pub dur: Option<f64>,
}

/// Returns `Ok(None)` when the file is readable but has no location.
pub fn read(_path: &Path) -> Result<Option<Meta>> {
    Err(Error::Unimplemented("meta::read"))
}
