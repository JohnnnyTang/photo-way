# Changelog

All notable changes to Photo Way are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Release notes on GitHub are extracted from the section for the tag.

## [Unreleased]

### Added
- Wave 0: Cargo workspace (`photoway-core`, `photoway-cli`, Tauri app) plus an npm workspace for the viewer and app UI.
- Wave 0: data contract and single-HTML embed contract (`docs/DATA_CONTRACT.md`, `schema/`).
- Wave 0: spike results adopted. HEIC decoding via libheif and libde265 built with vcpkg as static libraries
  (`vcpkg/triplets/`), and a MapLibre 6 viewer that works from `file://`.
- Wave 1: CI on Windows, macOS and Ubuntu (rustfmt, clippy, tests, viewer checks, size budgets, vcpkg binary cache).
- Wave 1: release workflow for `v*` tags. Windows NSIS and MSI installers, macOS universal dmg, CLI archives,
  SHA-256 checksums, and the LGPL corresponding-source tarball, published as a draft release.
- Wave 1: `scripts/version-sync.mjs`, `scripts/check-size.mjs`, `scripts/check-imports.mjs`, `scripts/lgpl-sources.mjs`.
- Dependabot for cargo, npm and GitHub Actions.

### Changed
- Tauri bundle targets pinned to NSIS, MSI, dmg and app; minimum macOS version set to 11.0.
