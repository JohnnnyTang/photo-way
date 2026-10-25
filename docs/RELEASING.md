# Releasing Photo Way

A release is a tag `vX.Y.Z` on `main`. The Release workflow builds everything and creates a **draft**
GitHub release; a person reviews and publishes it. Never move or delete a tag that has been pushed: fix
forward with the next patch version.

## Checklist

1. **Branch from main** (`release/vX.Y.Z`), and make sure CI on `main` is green.
2. **Bump the version everywhere** with `node scripts/version-sync.mjs X.Y.Z`. It updates `Cargo.toml`,
   `Cargo.lock` (workspace members), the three `package.json` files, `package-lock.json` and
   `app/src-tauri/tauri.conf.json`. `node scripts/version-sync.mjs --check` must pass.
3. **CHANGELOG.md**: rename `[Unreleased]` content into a `## [X.Y.Z] - YYYY-MM-DD` section. The workflow
   fails if that section is empty or missing, and uses it as the release notes. From v0.2.0 onward, include
   nonempty `### English` and `### 简体中文` subsections; the tag workflow requires both.
4. **Open a PR, merge it** once CI is green (size budgets, tests, e2e).
5. **Tag the merge commit**: `git tag vX.Y.Z <sha> && git push origin vX.Y.Z`. Tags with a hyphen
   (`v1.0.0-rc.1`) become prereleases.
6. **Release workflow** (`.github/workflows/release.yml`) runs on the tag: version check against the tag,
   viewer build, Windows NSIS + MSI, macOS universal dmg, CLI archives, installer size budget (15 MB),
   binary import check, LGPL source tarball, `SHA256SUMS.txt`, then the draft release. A manual
   `workflow_dispatch` run is a dry run (artifacts only, no release).
7. **Review the draft** on GitHub: notes read well; assets are present (see below); sizes are inside budget.
8. **Run release smoke** against the draft (see below). Do this before publishing.
9. **Hand check on macOS** (see below).
10. **Publish the draft.** Publishing fires `release: published`, which runs release smoke again against the
    public assets.

### Expected assets

| Asset | Notes |
|---|---|
| `Photo-Way_X.Y.Z_x64-setup.exe` | One NSIS installer with English and Simplified Chinese; per-user install, no admin |
| `Photo-Way_X.Y.Z_x64_en-US.msi` | English installer; the app includes both UI languages |
| `Photo-Way_X.Y.Z_x64_zh-CN.msi` | Simplified Chinese installer from v0.2.0; the app includes both UI languages |
| `Photo-Way_X.Y.Z_universal.dmg` | arm64 + x86_64 |
| `photoway-cli-X.Y.Z-windows-x64.zip`, `photoway-cli-X.Y.Z-macos-universal.tar.gz` | CLI plus LICENSE and notices |
| `third-party-sources-X.Y.Z.tar.gz` | LGPL corresponding source (libheif, libde265) |
| `THIRD_PARTY_NOTICES.md`, `licenses.zip` | licence texts |
| `SHA256SUMS.txt` | covers every other asset |

## Release smoke

`.github/workflows/release-smoke.yml` downloads the assets of a release (drafts included) onto clean
`windows-latest`, `macos-latest` (arm64) and `macos-15-intel` (x86_64 slice) runners and runs
`scripts/release-smoke.mjs`:

- verifies `SHA256SUMS.txt` against every asset;
- Windows: silent NSIS install (`/S`) and both MSI variants (`/qn`) from v0.2.0, one after the other; checks the exe, Start Menu
  shortcut, uninstall registry entry, exe file and product version, launches the app and checks it stays alive
  with a window for 10 s, then uninstalls silently and asserts files, shortcut and registry entry are gone;
- macOS: mounts the dmg, copies the app to a temp folder, `lipo -archs`, `codesign` verification (ad-hoc),
  `CFBundleShortVersionString`, launches the bundle binary for 10 s, detaches;
- CLI: `--version` equals the tag; `inspect`, `build` for html, dir and zip on generated inputs, `serve` plus
  an HTTP fetch;
- file associations: Photo Way registers none. The smoke test asserts that no extension keys appear on
  Windows and that `Info.plist` has no `CFBundleDocumentTypes`.

Run it: Actions, "Release smoke", Run workflow, `tag` = `vX.Y.Z` (blank = newest release, including a draft).
It also runs on pull requests that touch the workflow or its scripts. Note that `workflow_dispatch` only
appears for workflows that exist on `main`. Locally, download the assets with
`gh release download vX.Y.Z -D assets` and run `node scripts/release-smoke.mjs --tag vX.Y.Z --dir assets`
(this installs and uninstalls software for real; use a VM or throwaway machine).

The workflow needs `contents: write` because GitHub only shows draft releases to tokens with write access.

## Manual checks

Automation proves the bundle installs, starts and has the right version. It does not prove the app works.
For bilingual releases, check the NSIS language selector, English and Chinese installer text, app language
switching after each installer, and preservation of an existing app preference during upgrade. Installer
language must not overwrite the app preference. Check uninstall after each variant.
Before publishing, on a real Mac (Apple Silicon if possible): open the dmg, drag the app out, right-click, Open
(unsigned build), drop a folder with geotagged photos, preview the map, export a single HTML file and open it,
quit with Cmd+Q. Compare with the Windows flow in `docs/WAVE2_GATE.md`.

## Signing

Unsigned builds are the default (Windows SmartScreen and macOS Gatekeeper warnings are described in the
release notes' known limitations). The Release workflow skips signing steps when secrets are not set. Slots:

| Platform | Repository secrets |
|---|---|
| macOS sign + notarize | `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` |
| Windows sign | `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` |

Without Apple secrets the macOS app and CLI are ad-hoc signed (needed for arm64 to run at all).

## If a release is wrong

Do not re-tag. If the draft is wrong, delete the draft by hand and ship the next patch version. If a
published release is wrong, publish a fixed patch version and mark the bad one in the changelog.
