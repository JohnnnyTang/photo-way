//! photoway-core: scan geotagged photos and write portable route maps.
//!
//! Module map (see `docs/ARCHITECTURE.md`):
//! - [`model`]  — the project document (DATA_CONTRACT v1, frozen)
//! - [`scan`]   — walk inputs, classify files            (Wave 1 · A)
//! - [`meta`]   — GPS, capture time, dimensions          (Wave 1 · A)
//! - [`media`]  — decoding, thumbnails, web-size images  (Wave 1 · B)
//! - [`bundle`] — Html / Dir / Zip writers               (Wave 2 · E)
//! - [`serve`]  — local static server                    (Wave 2 · E)

pub mod bundle;
pub mod media;
pub mod meta;
pub mod model;
pub mod scan;
pub mod serve;

pub use model::{Item, Kind, Project, ProjectOptions};

/// Progress sink shared by long-running operations. Implementations must be cheap and thread-safe.
pub trait Progress: Send + Sync {
    /// `done` of `total` units finished; `label` describes the current unit (usually a file name).
    fn update(&self, done: u64, total: u64, label: &str);
    /// Polled between units; returning `true` aborts the operation with [`Error::Cancelled`].
    fn cancelled(&self) -> bool {
        false
    }
}

/// A [`Progress`] that ignores everything.
pub struct NoProgress;

impl Progress for NoProgress {
    fn update(&self, _: u64, _: u64, _: &str) {}
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("operation cancelled")]
    Cancelled,
    #[error("not implemented yet: {0}")]
    Unimplemented(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
