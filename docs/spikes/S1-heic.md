# Spike S1: HEIC decoding

Date: 2026-10-24 · Branch: `spike/heic` · Code: [`spikes/heic/`](../../spikes/heic) · Workflow: [`.github/workflows/spike-heic.yml`](../../.github/workflows/spike-heic.yml)

**Question.** Can we decode iPhone HEIC into RGB in Rust on Windows (MSVC x86_64) and macOS (arm64 and x86_64, universal), with the C libraries built from source and linked statically, so end users install nothing? What does it cost in build time, binary size and licensing?

## Verdict

**Yes. D4 holds, with one change: we use `libheif-rs`, but not the `embedded-libheif` feature.** Build libheif and libde265 as static libraries with **vcpkg** (pinned tag, overlay triplets, `libheif[core]`), and let `libheif-sys` find them: through the `vcpkg` crate on Windows and through `pkg-config` on macOS. We checked this in CI on all three targets plus a lipo'd universal binary. Each one decodes an iPhone-style gridded 12 MP HEIC with the orientation applied, and the binaries link only OS libraries.

The primary candidate as specified (`libheif-sys` `embedded-libheif`) **does not work for us:**

- **Windows MSVC:** the feature is ignored. `libheif-sys`'s `build.rs` always uses vcpkg on `windows`+`msvc`, so the build fails with `Could not find Vcpkg tree`.
- **macOS:** it builds libheif only, **not libde265** (the crate README says so). The result has no HEVC decoder and fails with `Support for this compression format has not been built in`. It also turns on every `WITH_*` codec and lets cmake find whatever is installed. On the GitHub runner that dynamically linked Homebrew's `libjpeg.8.dylib` and `libsharpyuv.0.dylib`, so the binary would not run on a user's Mac.

Fallbacks (b) ImageIO and (c) WASM were not needed. They are described briefly [below](#alternatives-not-built).

### Recipe for Wave 1

**Crates** (in `photoway-core`, behind `media::Decoder`):

```toml
libheif-rs = { version = "3.0.0", default-features = false, features = ["v1_17"] }   # pulls libheif-sys 5.3.1+1.23.1
# NOT "embedded-libheif". v1_17 = minimum libheif API, so a Linux job can still use distro libheif-dev (Ubuntu 24.04 ships 1.17.6).
```

**C libraries:** vcpkg tag **`2026.10.16`** gives **libheif 1.23.5** and **libde265 1.1.3**.

```
vcpkg install "libheif[core]:<triplet>" --overlay-triplets=<repo>/build/vcpkg-triplets --clean-after-build
```

`[core]` matters. The port's default feature `hevc` is the **x265 encoder (GPL-2.0-or-later)**. At this tag libde265 is a hard dependency of the port. On vcpkg master, libde265 has become its own default feature, so after a vcpkg bump the spec becomes `libheif[core,libde265]`. With `[core]` the installed set is exactly `libde265`, `libheif` and the two host helper ports.

**Overlay triplets** (copy them from `spikes/heic/triplets/`; all are static and release-only):

| Rust target | Triplet | Key settings |
|---|---|---|
| `x86_64-pc-windows-msvc` | `x64-windows-static-rel` | `VCPKG_CRT_LINKAGE static` (/MT), `VCPKG_LIBRARY_LINKAGE static`, `VCPKG_BUILD_TYPE release` |
| `aarch64-apple-darwin` | `arm64-osx-pw` | static, `VCPKG_OSX_ARCHITECTURES arm64`, `VCPKG_OSX_DEPLOYMENT_TARGET 11.0`, release |
| `x86_64-apple-darwin` | `x64-osx-pw` | static, `VCPKG_OSX_ARCHITECTURES x86_64`, `VCPKG_OSX_DEPLOYMENT_TARGET 11.0`, release |

On Windows, the triplet name must contain `-static`: the `vcpkg` crate decides static linking with `triplet.contains("-static")`.

**Environment for `cargo build`** (put it in CI env and in a `scripts/setup-libheif.{ps1,sh}` for developers):

| Platform | Variables |
|---|---|
| Windows | `VCPKG_ROOT=<vcpkg dir>`, `VCPKGRS_TRIPLET=x64-windows-static-rel` |
| macOS | `PKG_CONFIG_LIBDIR_aarch64_apple_darwin=$VCPKG_ROOT/installed/arm64-osx-pw/lib/pkgconfig`, `PKG_CONFIG_LIBDIR_x86_64_apple_darwin=$VCPKG_ROOT/installed/x64-osx-pw/lib/pkgconfig`, `PKG_CONFIG_ALLOW_CROSS=1`, `SYSTEM_DEPS_LIBHEIF_LINK=static`, `MACOSX_DEPLOYMENT_TARGET=11.0` |

- Use `LIBDIR`, not `PATH`. It replaces pkg-config's default search directories, so a developer's Homebrew `libheif.pc` can never be picked up.
- The target-suffixed names let one `tauri build --target universal-apple-darwin` build both slices.
- `SYSTEM_DEPS_LIBHEIF_LINK=static` makes `system-deps` emit `static=heif`, `static=de265`, plus `c++` and `m` (taken from vcpkg's fixed-up `libheif.pc`).

**Windows CRT.** Keep Tauri's default `build.windows.staticVCRuntime = true`. With the /MT triplet, the exe then imports only UCRT `api-ms-win-crt-*` (part of Windows 10+): no `VCRUNTIME140.dll` and no `MSVCP140.dll`.

The CLI doesn't go through `tauri-build`. Give `crates/cli` the same behaviour with a one-line `build.rs` (`static_vcruntime = "3.0.0"` build-dependency, `static_vcruntime::metabuild()`), which is the configuration we tested as `mt-tauri`. The other option is `-C target-feature=+crt-static` in `.cargo/config.toml` for `cfg(all(windows, target_env = "msvc"))`; we tested that as `mt-crtstatic` and it gives zero CRT DLL imports. The default `x64-windows-static-md` triplet (/MD) builds and runs, but libheif's C++ code then imports **`MSVCP140.dll` + `VCRUNTIME140_1.dll`**, i.e. the VC++ redistributable, which Tauri's static VC runtime does not cover.

**macOS x86_64 extra link input.** libde265's x86 SIMD dispatch (`sse.cc`, `__builtin_cpu_supports`) needs `___cpu_model` / `___cpu_indicator_init` from clang's compiler-rt. rustc links Apple targets with `-nodefaultlibs`, so add `libclang_rt.osx.a`:
- The spike's bin-crate `build.rs` does this with `cargo:rustc-link-arg=$(xcrun clang -print-resource-dir)/lib/darwin/libclang_rt.osx.a`.
- **In Wave 1 the build script will live in a library crate (`photoway-core`).** There, `rustc-link-arg` does not reach the final binary, so emit `cargo:rustc-link-search=native=<resource-dir>/lib/darwin` + `cargo:rustc-link-lib=static=clang_rt.osx` instead (only for `x86_64-apple-darwin`; not tested in this exact form).

**Tauri config:** `bundle.macOS.minimumSystemVersion = "11.0"`, to match the triplets. CI checked `LC_BUILD_VERSION minos 11.0`, and there were no "built for newer macOS" linker warnings.

**Tools:**
- **Windows:** only Visual Studio (Build Tools) with the C++ workload, plus git. vcpkg downloads its own cmake 4.4.3, 7-Zip, PowerShell 7 and msys2 `pkgconf`.
- **macOS:** Xcode CLT, cmake and pkg-config (`brew install cmake pkgconf`; both are preinstalled on GitHub runners).
- **nasm is not needed** (libde265 uses intrinsics, not asm).

**CI caching:** set `VCPKG_BINARY_SOURCES=clear;files,$RUNNER_TEMP/vcpkg-bin,readwrite` and `actions/cache` that directory, keyed on triplet + vcpkg tag + `hashFiles(triplets/*)`. The vcpkg step then takes 8–13 s warm, against 1–3.6 min cold. See the workflow for a working example.

**Decoding rules for B (media):**
- `LibHeif::decode(&primary_handle, ColorSpace::Rgb(RgbChroma::Rgb), None)` applies `irot`/`imir`/`clap`. **Do not apply EXIF Orientation again on HEIC pixels.** iPhone files carry both, and applying both would rotate twice.
- Copy rows using `plane.stride`; it is not `width*3`.

## Results

Test input: a synthetic 4032×3024 JPEG with EXIF Orientation 6, whose stored top-left quadrant is red (`heic-spike gen`). We generated it in CI on macOS and converted it two ways (see the `sample` job). Both outputs are true 12 MP HEICs with the rotation stored as `irot` (angle 270° ccw):

- **`sips-o6.heic`** (Apple ImageIO): **6×8 grid of 512×512 HEVC tiles**, which is the same structure iPhone photos use. 3.9 MB.
- **`heifenc-o6.heic`** (`heif-enc` from Homebrew libheif 1.23.6): one 12 MP HEVC frame. 6.2 MB.

The files are large because the image is noise-heavy, so they are CI artifacts only and not committed. The content is our own, so there is no licence question.

The binary decodes the primary image, center-crops and resizes it to 256×256 (`fast_image_resize` 6.1.0), writes a JPEG at q78 (`image` 0.25.10) and asserts that the decoded image is 3024×4032 with red in the **top-right** quadrant, i.e. the orientation was honoured.

### Per target (CI, run [40066667704](https://github.com/JohnnnyTang/photo-way/actions/runs/40066667704): clean, no caches)

| Target | Variant | Build OK | vcpkg install (cold) | cargo release build, clean: image-only / +libheif | Binary: image-only → with libheif | Δ size | Decode 12 MP grid (iPhone-like) | Decode 12 MP single-frame | Orientation | Runtime deps |
|---|---|---|---|---|---|---|---|---|---|---|
| x86_64-pc-windows-msvc | **mt-tauri** (/MT libs + static vcruntime) | yes | 173 s | 90 s / 97 s | 1,123,328 → 2,628,608 B | **+1.44 MiB** | 336 ms | 665 ms | yes | KERNEL32, ntdll, UCRT `api-ms-win-crt-*` only |
| x86_64-pc-windows-msvc | mt-crtstatic (/MT + `+crt-static`) | yes | 215 s | 108 s / 110 s | 1,215,488 → 2,841,600 B | +1.55 MiB | 384 ms | 797 ms | yes | KERNEL32, ntdll only |
| x86_64-pc-windows-msvc | md (vcpkg-rs default /MD) | yes | 216 s | 107 s / 108 s | 1,101,312 → 2,552,320 B | +1.38 MiB | 395 ms | 804 ms | yes | **adds MSVCP140, VCRUNTIME140(_1)** ✗ |
| aarch64-apple-darwin | std | yes | 117 s | 55 s / 43 s | 667,680 → 2,079,552 B | **+1.35 MiB** | 322 ms | 1,057 ms | yes | `/usr/lib/libc++.1`, libSystem, libiconv |
| x86_64-apple-darwin | std (built on arm64 runner, run under Rosetta 2) | yes | 68 s | 53 s / 47 s | 1,232,672 → 2,877,912 B | **+1.57 MiB** | 307 ms* | 687 ms* | yes | `/usr/lib/libc++.1`, libSystem, libiconv |
| universal-apple-darwin | `lipo -create` of the two above | yes | n/a | n/a | 4,979,520 B (fat) | n/a | 365 ms (arm64 slice), 475 ms (x86_64 slice, Rosetta) | 909 / 1,036 ms | yes | same |

- Decode time is the best of 3 in one process, wall clock, `HeifContext::read_from_file` + `decode` to interleaved RGB. Crop and resize to 256² take another 9–19 ms.
- For comparison, the `image` crate decodes the same scene as a 12 MP JPEG in 96–168 ms.
- \* Under Rosetta, not native Intel.
- "Clean cargo build" is `cargo clean` followed by `cargo build --release` with LTO, `codegen-units=1`, `opt-level="s"` and strip (the root workspace profile). The two cargo builds take about the same time because libheif-sys only probes pkg-config/vcpkg. **The C build cost is all in the vcpkg step:** 1–3.6 min cold, **8–13 s with the binary cache** ([run 40067465707](https://github.com/JohnnnyTang/photo-way/actions/runs/40067465707)).
- Size: libheif + libde265 add about **1.4–1.6 MiB per architecture** (about 3 MiB in a universal macOS app), well within the 15 MB installer budget.
- Gridded files decode 2–3× faster than single-frame ones because libheif decodes tiles in parallel. iPhone files are gridded, so expect **about 0.3 s per 12 MP iPhone photo per process** on CI-class machines.
- libde265 has SSE paths for x86 but little NEON for arm64, so native arm64 is not faster than x86_64 under Rosetta.

**Embedded path** (job `embedded`, same runs):

| Target | Result |
|---|---|
| Windows MSVC | **fails** in about 25 s: `libheif-sys` ignores the feature and goes to vcpkg, which reports `Could not find Vcpkg tree` (exit 101). |
| macOS arm64 | builds (84–107 s, cmake build of libheif); `LIBDE265 ... not found` / `Not compiling 'libde265' backend`. The only decoder is `jpeg`, and decoding HEIC fails. `otool -L` shows `/opt/homebrew/opt/jpeg-turbo/lib/libjpeg.8.dylib` and `/opt/homebrew/opt/webp/lib/libsharpyuv.0.dylib`: **not portable**. |

### Local Windows build (this machine)

**A developer can build locally.** What they need: VS Build Tools with the "Desktop development with C++" workload (MSVC 14.44 + Windows SDK; here at `D:\software\visualStudio\buildTools`), git, and Rust stable. cmake on PATH is **not** needed for the vcpkg route. The VS-bundled cmake (`Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin`, 4.3.1-msvc1) only matters for `embedded-libheif`, and that fails before it gets to cmake.

| Step | Time on this laptop |
|---|---|
| `git clone --depth 1 --branch 2026.10.16 https://github.com/microsoft/vcpkg` | 23 s |
| `bootstrap-vcpkg.bat -disableMetrics` | 20 s |
| `vcpkg install libheif[core]:x64-windows-static-md-rel --overlay-triplets=spikes/heic/triplets` (first time; includes downloading cmake/7z/pwsh/pkgconf) | 4.8 min |
| `vcpkg install libheif[core]:x64-windows-static-rel ...` (second triplet, tools cached) | 2.2 min |
| `cargo build --release` (clean, `VCPKG_ROOT` + `VCPKGRS_TRIPLET` set) | 64–98 s |
| Decode `sips-o6.heic` / `heifenc-o6.heic` | 287–301 ms / 772–851 ms, orientation OK |

The /MT + `HEIC_SPIKE_STATIC_VCRUNTIME=1` (Tauri-style) local binary imports only KERNEL32, ntdll and UCRT, which matches CI. The static `heif.lib` is about 200 MB on disk (debug info in the static lib), but that only affects disk and cache size; the stripped exe is 2.6 MB.

## Licensing

| Component | Licence | Notes |
|---|---|---|
| libheif 1.23.5 | **LGPL-3.0-only** (the library). Its examples, Go/C++ wrappers and `heif_cxx.h` are MIT. | © 2017–2020 Struktur AG, © 2017–2026 Dirk Farin |
| libde265 1.1.3 | **LGPL-3.0-only** (library; sample apps MIT). On Windows it compiles `extra/win32cond.c`, which is under the permissive **DOC licence** (ACE/TAO, © 1993–2009 Douglas C. Schmidt et al.). | © 2013–2014 Struktur AG, © 2013–2026 Dirk Farin; vcpkg records `LGPL-3.0-only AND DOC` |
| `libheif-rs` 3.0.0, `libheif-sys` 5.3.1 | MIT | Rust bindings only |
| x265 / x264 / aom | not included | `[core]` keeps out GPL-2.0 x265 and x264 |

Static linking turns Photo Way into a "Combined Work" under LGPL-3.0 §4. Our app staying MIT is fine. Each binary release (installer, portable zip, CLI) must meet these obligations:

1. **Notice (§4a).** State prominently that the app uses libheif and libde265 and that they are covered by the LGPL-3.0. Put this in `THIRD_PARTY_NOTICES.txt`, shipped inside the installer, bundle and CLI zip, and in the app's About box.
2. **Licence texts (§4b).** Ship the full text of the **GPL-3.0 and LGPL-3.0**. vcpkg's `installed/<triplet>/share/{libheif,libde265}/copyright` files contain both, plus the DOC notice for `win32cond.c`. Copy them verbatim into a `licenses/` folder in the app resources and the CLI zip.
3. **Copyright notices (§4c).** The app displays copyright notices (the About box), so the libheif and libde265 copyright lines must be listed there too.
4. **Relinking (§4d0).** We cannot rely on a shared library, so we use option 0:
   - **Corresponding Application Code:** our full MIT source plus `Cargo.lock` is public, so a user can rebuild against a modified libheif or libde265 (vcpkg overlay port, or a different `VCPKG_ROOT`).
   - **Minimal Corresponding Source of the libraries:** the exact `libheif-1.23.5` and `libde265-1.1.3` source tarballs, plus the vcpkg port files and patches that were applied (`ports/libheif/*.diff|patch`, `ports/libde265/*`) and our overlay triplets.
   - **How to provide it:** GPL §6(d) says equivalent access must come "from the same place". So **attach a `third-party-sources-<version>.tar.gz` to every GitHub Release** (about 3 MB) and write the steps in `docs/BUILDING.md`. Linking to the upstream tags alone is weaker, because we would stay responsible for their availability.
5. **No terms that forbid reverse engineering or modification for the user's own use (§4).** MIT already allows both, so the EULA and README must not add such terms.
6. **Installation information (§4e / GPL §6).** Only applies to "User Products" (consumer devices). It does not apply to desktop software on general-purpose PCs. Code signing or notarisation does not stop anyone relinking, since a user can re-sign ad hoc.

Wave 3 (I · release hardening) should automate items 1, 2 and 4: collect the copyright files from vcpkg, generate the notices file, build the sources tarball, and upload it with the release.

## Gotchas hit (and fixes)

1. **`embedded-libheif` is not a portable static build.** It is ignored on Windows MSVC, skips libde265, and picks up host Homebrew libraries on macOS. Fix: don't use it; build with vcpkg.
2. **vcpkg default feature `hevc` = x265 (GPL).** Also, `libheif-sys`'s own `[package.metadata.vcpkg]` (for `cargo vcpkg build`) asks for `libheif[hevc,aom,x264,h264-decoder,jpeg]`, which includes GPL x264/x265 and many extra builds. Fix: install `libheif[core]` ourselves and don't use cargo-vcpkg's metadata.
3. **Port feature names depend on the vcpkg version.** `libheif[core,libde265]` fails at tag 2026.10.16 with `libheif has no feature named libde265`. Fix: pin the vcpkg tag and use the right spec for that tag.
4. **The /MD triplet adds a `MSVCP140.dll` dependency.** Fix: use the /MT triplet together with Tauri's static VC runtime (or `+crt-static`).
5. **x86_64-apple-darwin link error:** `Undefined symbols: ___cpu_model, ___cpu_indicator_init` from libde265 `sse.cc`. Fix: link `libclang_rt.osx.a` (see the recipe). arm64 is not affected.
6. **Cross pkg-config on an arm64 host** needs `PKG_CONFIG_ALLOW_CROSS=1` and target-suffixed `PKG_CONFIG_LIBDIR_<target>`.
7. **macOS deployment target.** vcpkg's stock osx triplets don't pin one, so objects are built for the SDK (26.x) while Rust links for 11.0 or 10.12. Fix: overlay triplets with `VCPKG_OSX_DEPLOYMENT_TARGET 11.0`, plus `MACOSX_DEPLOYMENT_TARGET=11.0` for cargo. Verified `minos 11.0` and no linker warnings.
8. **Orientation.** libheif applies `irot`/`imir` itself; EXIF orientation must not be applied a second time for HEIC.
9. **CI-only issues:**
   - `runner.temp` isn't available in `jobs.<id>.env`, so set `VCPKG_ROOT` through `$GITHUB_ENV`.
   - `cmd | tee | grep | head` under `bash -o pipefail` dies with SIGPIPE (exit 141) and hides the real exit code. Fix: write to a log file, then `grep … | tail`.

## Alternatives (not built)

- **(b) macOS ImageIO + something for Windows.** `objc2-image-io` / `objc2-core-graphics` (`CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceCreateThumbnailWithTransform`) gives oriented, hardware-accelerated thumbnails with no size or licence cost on macOS. Windows has no free equivalent: WIC needs the Store "HEIF Image Extensions" plus "HEVC Video Extensions" (paid or OEM-only), which breaks "users install nothing". It could become an optional macOS fast path behind `Decoder` later; it doesn't solve Windows.
- **(c) WASM decoder in the webview** (libheif + libde265 compiled with emscripten, e.g. the `libheif-js` npm package, about 1.5 MB). It is still LGPL, though compliance is easier because the wasm file is a separately replaceable library. Costs: roughly 2–4× slower than native, 12 MP RGBA buffers passed over IPC, and the **CLI has no webview**, which breaks "one core for app and CLI". Use it only as a last resort.

## Open items for Wave 1

- Throughput: B's target is 1,000 HEICs in 60 s (60 ms per image). At about 0.3 s per gridded 12 MP decode, already multithreaded inside libheif, that needs real parallelism. Benchmark rayon × libheif's per-file thread count (`DecodingOptions`) on a real 8-core laptop.
- Check whether real iPhone files carry a usable embedded thumbnail item. Our ImageIO sample had none.
- Wave 1 D: add a CI assertion (dumpbin/otool) that release binaries import only OS libraries, and a licence-bundle step.
- Fixtures: a small (< 300 KB) HEIC made by us, e.g. `sips -s format heic` on a 1024×768 synthetic JPEG, is fine to commit for tests.

## CI runs

- **Clean build, all targets green:** https://github.com/JohnnnyTang/photo-way/actions/runs/40066667704
- **Final config (LIBDIR), warm vcpkg cache, all targets green:** https://github.com/JohnnnyTang/photo-way/actions/runs/40067465707
- x86_64 macOS link failure (`___cpu_model`) before the compiler-rt fix: https://github.com/JohnnnyTang/photo-way/actions/runs/40065826889

In every run the `embedded` jobs are `continue-on-error`. The Windows one fails by design, and the macOS one builds but cannot decode HEIC.
