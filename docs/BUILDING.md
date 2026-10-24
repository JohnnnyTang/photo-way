# Building Photo Way

Photo Way needs Node.js 24, Rust stable (at least 1.88), and a C/C++ toolchain. The
release workflow builds Windows x64 and macOS universal installers. Linux is tested
in CI, but is not packaged for release yet.

## Build locally

Install JavaScript dependencies and build the viewer before compiling Rust. The
viewer output is embedded in the Rust binaries.

```sh
npm ci
npm run build -w viewer
npm run build -w app
```

On Windows, install Visual Studio Build Tools with Desktop development with C++,
then run `pwsh scripts/setup-libheif.ps1`. Set `VCPKG_ROOT` and `VCPKGRS_TRIPLET`
in the shell as printed by the script before `cargo build --release`.

On macOS, install Xcode Command Line Tools, CMake and pkg-config. Run
`bash scripts/setup-libheif.sh --universal` for both architectures. Export the
environment variables printed by the script, then use
`npm run tauri -w app -- build --target universal-apple-darwin` for the app and
build each CLI target with Cargo before combining them with `lipo`.

On Ubuntu, install `libheif-dev`, `pkg-config`, and the Tauri/WebKitGTK
dependencies listed in `.github/workflows/ci.yml`. Then run `cargo test --workspace`.

## Rebuild with modified LGPL libraries

Every tagged release attaches `third-party-sources-<version>.tar.gz`. It contains
the exact libheif and libde265 sources, vcpkg port files and patches, and Photo
Way's overlay triplets. The corresponding Photo Way source, including
`Cargo.lock`, is at the same GitHub release tag.

1. Check out the Photo Way release tag and unpack the third-party source archive.
2. Clone vcpkg at tag `2026.10.16`. Copy the archive's `vcpkg/ports/libheif`
   and `vcpkg/ports/libde265` into a separate overlay-ports directory.
3. Modify the library source and edit those overlay portfiles to use your local
   source path. Keep `libheif[core]` so GPL encoders are not pulled in.
4. Install with `vcpkg install libheif[core]:<triplet>
   --overlay-triplets=<repo>/vcpkg/triplets
   --overlay-ports=<your-overlay-ports>`. Use `x64-windows-static-rel` on Windows,
   or `arm64-osx-pw` and `x64-osx-pw` for macOS universal.
5. Set `VCPKG_ROOT` to that checkout and the Cargo environment variables described
   in `docs/spikes/S1-heic.md`, then rebuild the app and CLI from the release tag.

The library and application licences, copyright notices, and source archive are
also included with each release. Photo Way's MIT licence permits modification
and reverse engineering for your own use.
