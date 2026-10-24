//! Write projects as single HTML, folder, or zip. Owner: Wave 2 · E.

use std::path::{Path, PathBuf};

use crate::media::Prepared;
use crate::model::Project;
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Html,
    Dir,
    Zip,
}

#[derive(Debug, Clone)]
pub struct WriteReport {
    pub path: PathBuf,
    pub bytes: u64,
}

pub fn write(_prepared: &Prepared, _project: &Project, _format: Format, _out: &Path) -> Result<WriteReport> {
    Err(Error::Unimplemented("bundle::write"))
}
