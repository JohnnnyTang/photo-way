# Wave 4 implementation gate

Status: in progress. This records implementation evidence; it is not a release sign-off.

This N worktree starts from the newer v0.1.1 `main` commit. The K and L/M descriptions below record work in the shared checkout; those changes are not in this worktree yet. Re-run their checks after integration.

## Stream K — contracts

- Locale normalization, precedence, formatting, and in-place change notification: `shared/locale.ts`.
- Typed English and Simplified Chinese catalogs cover the keys currently in `app/ui/src/strings.ts` and `viewer/src/strings.ts`; selectors are in each surface's `catalog.ts`. The backend error and scan-reason catalog is `shared/messages.ts`. L and M still need to consume these catalogs and address visible text outside the existing string files.
- App settings add `language` (`system`, `en`, `zh-CN`) and independent nullable `exportLanguage`; old settings default to `system` and no export choice. The UI will resolve the initial export choice from the system in L.
- Project v1 adds optional `options.lang` in Rust, TypeScript, schema, and contract. Missing field loads as `None`/`undefined`; explicit unsupported values have a viewer fallback contract. Real export and Save a copy integration belong to M.
- Finished-operation events add stable `code` and optional `params` while preserving raw `message` for diagnostics. Scan groups already expose stable `reason` values; the existing English `label` remains for older UI clients.

## Text ownership inventory

| Source | Owner for Wave 4 | Notes |
|---|---|---|
| `app/ui/src/strings.ts`, `app/ui/index.html`, `app/ui/src/main.ts` | L | Shell labels, summaries, options, progress, pickers, errors, accessible preview title. Dynamic counts and dates need locale formatters. |
| `app/src-tauri/src/menu.rs` | L | App-owned menus and About dialog; native predefined Edit actions and OS file picker chrome follow the system. |
| `app/src-tauri/src/summary.rs`, `commands.rs` | K/L | Stable scan reason and error codes; keep file paths and raw technical details untranslated. |
| `viewer/src/strings.ts`, `viewer/src/app.ts`, `viewer/src/template.html` | M | Controls, accessibility names, tooltips, dynamic menus and dialogs. Preserve project title and media filenames. |
| `viewer/src/days.ts`, `viewer/src/util.ts`, formatting helpers | M | Localized day, count, unit and date display; no changes to date grouping or serialization. |
| `crates/core/src/bundle.rs` generated README | M | Bundle instructions in both languages; no network fetch. |
| Map tile labels, provider attribution, proper names, licenses | Exception | Provider content and legal wording stay as supplied. |
| CLI command names, flags, JSON keys, reason codes and diagnostics | Exception | Machine-readable interfaces remain stable; only `--lang` is added in M. |

## Verification

Completed on 2026-10-24:

- `npm run typecheck -w viewer` — passed.
- `npm run typecheck -w app` — passed.
- `npm run test -w viewer -- --run tests/unit/locale.test.ts` — 5 passed; checks locale behavior and catalog shape, parameters, and IDs.
- `cargo test -p photoway-core model::tests --lib` — 4 passed, including an old project document with a Chinese filename.
- `cargo test -p photoway-app settings::tests --lib` — 4 passed with `TEMP` and `TMP` set to a workspace temp directory. The first run used the system temp directory and failed with permission denied under the workspace sandbox.
- `cargo fmt --all -- --check` and `git diff --check` — passed.

Pending: full L/M integration, export/browser tests, installer QA, documentation, and release checks.

## Stream N — documentation, packaging, release preparation

- English and Simplified Chinese README/user guides are linked in both directions. Their v0.2.0 language instructions explicitly describe work in progress until L/M integration is verified.
- The Tauri bundle config requests NSIS `English`/`SimpChinese` with a visible selector and separate WiX `en-US`/`zh-CN` MSI outputs. Tauri documents that MSI list entries create separate files with language suffixes; NSIS remains one multilingual setup. Installer language does not set the app preference.
- `scripts/changelog-notes.mjs` requires nonempty `### English` and `### 简体中文` sections for tagged versions from v0.2.0 onward; historical v0.1.x notes remain valid. `scripts/check-windows-installers.mjs` makes the release package step reject missing or duplicate Windows installer variants.
- CI runs the viewer locale/catalog parity tests in its viewer test step and typechecks the app UI before the Rust matrix builds it. The existing end-to-end job runs Chromium, Firefox, and WebKit on Windows and macOS; bilingual scenarios still need to land with M.
- Installer size limits remain at the existing 15 MiB per file. Measure the produced NSIS, both MSI files, macOS DMG, and viewer/output budgets at integration; no budget has been raised.
- Earlier local checks in the shared checkout on 2026-10-24: Tauri CLI `inspect wix-upgrade-code` accepted the configuration and reported default upgrade code `80825a6b-63ae-5b29-93b5-4e137820de6b`; a fixture with one NSIS and two locale-suffixed MSI files passed the asset check; v0.1.0 changelog extraction with `--require` passed; v0.2.0 with `--require` failed because release notes have not been written yet (expected); app typecheck and viewer locale tests passed. Re-run checks in this worktree after its adaptation to v0.1.1. These checks do not prove installer build or install behavior.

Pending: actual Windows/macOS bundle builds, install/upgrade/uninstall smoke checks, browser matrix after M integration, translation review after L/M integration, and v0.2.0 release notes/version sync. No tag or release has been created.

### N worktree recheck on the v0.1.1 baseline

- Branch: `codex/wave4-session-n`, based on `c4f6cf3` (released v0.1.1). The existing long English user guide and release smoke checks were retained and extended. The Chinese guide now covers installation, getting geotagged originals, app and viewer controls, privacy, CLI use, and troubleshooting.
- `node --check` passed for `changelog-notes.mjs`, `check-windows-installers.mjs`, and `release-smoke.mjs`; `git diff --check` passed.
- `node scripts/changelog-notes.mjs v0.1.1 --require` passed. The same command for v0.2.0 rejected the missing section as expected.
- A Windows artifact fixture with NSIS, `en-US` MSI, and `zh-CN` MSI passed; removing the Chinese MSI made the check fail as expected.
- The release smoke script is prepared to install and uninstall both MSI variants from v0.2.0 onward. No real installers have been built or smoke-tested in this worktree.
