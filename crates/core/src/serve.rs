//! Local static server for a folder, zip, or single HTML. Owner: Wave 2 · E.

use std::net::SocketAddr;
use std::path::Path;

use crate::{Error, Result};

pub struct ServerHandle {
    pub addr: SocketAddr,
}

pub fn serve(_path: &Path, _addr: SocketAddr) -> Result<ServerHandle> {
    Err(Error::Unimplemented("serve::serve"))
}
