//! Local static server for a folder, zip, or single HTML. Owner: Wave 2 · E.
//!
//! Signatures here are frozen for Wave 2 (the app and the E2E suite build against them).

use std::net::SocketAddr;
use std::path::Path;

use crate::{Error, Result};

/// A running server. Dropping it stops the server.
pub struct ServerHandle {
    /// The bound address (the real port when the requested port was 0).
    pub addr: SocketAddr,
}

impl ServerHandle {
    /// `http://<addr>/`, the URL that opens the map.
    pub fn url(&self) -> String {
        format!("http://{}/", self.addr)
    }

    /// Stops the server and waits for its threads.
    pub fn stop(self) {}

    /// Blocks until the server stops (the CLI's `serve` runs until Ctrl+C).
    pub fn wait(self) {}
}

/// Starts serving in background threads and returns once the socket is bound.
/// `path` is a bundle directory, a `.zip` bundle (served without extracting), or a single `.html`.
pub fn serve(_path: &Path, _addr: SocketAddr) -> Result<ServerHandle> {
    Err(Error::Unimplemented("serve::serve"))
}
