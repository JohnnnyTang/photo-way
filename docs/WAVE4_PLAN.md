# Wave 4 — Bilingual release

Status: planned on 2026-10-24 at the owner's request. Baseline: released v0.1.0. Target: v0.2.0; no calendar deadline. This document plans the work; it does not claim that localization is implemented or tested.

Since this plan was written, v0.1.1 has also been released. Session N's worktree starts from that newer `main` commit; the v0.1.x compatibility and upgrade checks below apply to both published versions.

## 1. Release outcome

Users can install Photo Way, import media, preview a trip, export it, and share an offline map entirely through English or Simplified Chinese UI. Both languages ship together in every subsequent release. A recipient can change the exported map's language without installing Photo Way or connecting to the internet.

- Supported UI locales: `en` (English) and `zh-CN` (简体中文).
- One application identity, version, source tree, and Git tag; no separate Chinese fork or update channel.
- Windows: one bilingual NSIS setup executable, plus English and Simplified Chinese MSI installers containing the same bilingual app. macOS: one universal DMG containing the bilingual app.
- Language-specific MSI filenames identify the installer language; users can select either app language after installation. Installer language does not silently overwrite an existing app preference.
- English and Chinese documentation and release notes accompany each release from v0.2.0 onward.
- Published v0.1.0 assets and tag remain intact. Existing standalone exports retain their embedded viewer; users generate a new export to gain bilingual controls.

Traditional Chinese, additional languages, translated CLI help/diagnostics, automatic translation of photo titles or filenames, and localization of text baked into third-party map tiles are outside this wave. The CLI gains export-language selection; command names, JSON keys, reason codes, and other machine-readable interfaces stay stable. GPX, privacy zones, inferred GPS, and the other Wave 3 extras remain backlog.

## 2. Language behavior and compatibility

| Surface | Planned behavior |
|---|---|
| Desktop app | `System / English / 简体中文` setting. Resolve an explicit saved choice first, otherwise the system locale, then English. Keep the choice across restarts and upgrades. |
| System/browser locale matching | Canonicalize locale tags. Match English variants to `en`; match `zh-CN`, `zh-SG`, `zh-Hans` variants and bare `zh` to `zh-CN`. Unsupported languages, including Traditional Chinese variants, fall back to English and retain manual Chinese selection. |
| Export default | Separate `English / 简体中文` option, initially the resolved app language and then remembered independently. Write the explicit locale into new projects/exports. Preview uses this export language. |
| Exported viewer | `English / 简体中文` selector. Resolve a saved choice for that project first, then its supported embedded language, then browser language when the field is absent, then English. An explicit unsupported embedded value falls back to English. |
| Save a copy | Embed the currently selected language as the copy's default alongside existing corrections and visibility edits. Verify the default in a fresh browser context with no saved preference. |
| Storage unavailable | Language switching still works for the open session. An export or saved copy carries its default without requiring browser storage. |
| Older settings and projects | Deserialize missing fields safely. Existing explicit choices win; missing app settings use System. Existing standalone v0.1.0 exports are unchanged. New code must read older project data without losing photos or edits. |

Use a project-scoped language preference in the viewer so opening one trip does not change another trip's language. The current viewer's general preferences use a global key; add language persistence deliberately rather than changing unrelated preference behavior.

Switching language must preserve imported media, user-entered titles, export options, map position, selected day, filters, and location edits. Use an in-place update that does not cancel processing or lose progress. Update the HTML `lang` attribute, accessible labels, tooltips, and open UI surfaces. Native controls whose labels are supplied by the operating system may follow OS language; document and test that boundary.

Localize date labels, counts, units, and messages without changing capture timestamps, local-day grouping, ordering, coordinates, or serialized numbers. Do not translate user content or overwrite an edited trip title when changing the language.

## 3. Implementation workstreams

### K — Locale foundations and contracts (first)

Primary scope: shared locale utilities/catalog types, app settings and API definitions, Rust/TypeScript project models, JSON Schema, and `docs/DATA_CONTRACT.md`.

1. Inventory visible text in `app/ui/src/strings.ts`, `viewer/src/strings.ts`, HTML templates, native menus/dialogs, formatting helpers, scan summaries, backend errors, and generated bundle instructions. Record ownership and deliberate exceptions such as proper names, legal attribution, and technical diagnostics.
2. Introduce small typed catalogs for both locales with matching keys and interpolation parameters. Keep translation values as text by default; retain existing escaping for user-supplied data. Bundle catalogs at build time with no runtime translation service, fetch, or CDN dependency.
3. Define locale normalization, precedence, formatting, and language-change notification APIs shared where practical. Avoid adding a large localization dependency for two catalogs.
4. Define separate app-language preference and concrete export-language fields. The roadmap mentions `options.lang`, but the current models/schema need an implementation audit: update Rust, TypeScript, schema, fixtures, and contract documentation together. Prefer an optional additive field with safe defaults; verify compatibility before retaining data format version 1.
5. Define stable codes and parameters for app-facing backend messages so presentation can be localized without parsing English error strings. Show a translated explanation and preserve raw technical details where useful.

Acceptance: tests cover locale resolution, missing/invalid values, catalog key/parameter parity, old-settings migration, and project serialization compatibility. Contracts land before L and M consume them.

### L — Desktop app and native UI

Primary scope: `app/ui/`, `app/src-tauri/src/settings.rs`, `menu.rs`, `commands.rs`, and relevant app API bindings.

1. Add a discoverable `Language / 语言` control and independent export-language option with the behavior in §2.
2. Translate import, progress, cancellation, summary/skip reasons, options, privacy warnings, export/results, empty states, errors, and About text.
3. Localize app-owned native menu and dialog text; synchronize changes with the app UI and preserve keyboard shortcuts.
4. Use readable system CJK font fallbacks, flexible control widths, and wrapping. Check the minimum supported window size, long filenames, and Chinese input.
5. Pass the export locale into the preview and every export path. Upgrades preserve existing settings and use safe defaults for new fields.

Acceptance: import → preview → export → open/reveal works in both languages; switching during processing preserves the operation and its state; language survives restart; old settings migrate; paths and titles containing Chinese characters work.

### M — Viewer, core export, and CLI integration

Primary scope: `viewer/`, `crates/core` export generation, and `crates/cli`. Consume K's models without independently redefining contracts.

1. Translate toolbar, menus, themes, basemap controls, filters, timeline, day navigation, cards, modal, playback, editing, Save a copy, and error/empty states. Audit hard-coded month/day names and English number formatting.
2. Implement language switching and per-project persistence, including content rendered after the initial mount. Preserve trip state and keep event handlers from accumulating on repeated switches.
3. Include both catalogs in HTML, folder, and ZIP exports; localize generated instructions or include bilingual instructions. No additional network requests are needed for language selection.
4. Add a documented CLI `build --lang en|zh-CN` option with English as the default for existing CLI usage; reject unsupported explicit values clearly. Preserve script-facing output and exit behavior.
5. Carry language through preview, all export formats, and Save a copy. Maintain HTML/script escaping and offline behavior.

Acceptance: both locales pass viewer flows from actual exports; edits persist through switching/reload; Save a copy carries its chosen language; language remains usable with storage blocked and the network offline; older project fixtures still load.

### N — Documentation, installers, QA, and release

Primary scope: README/user guides, changelog, release scripts, Tauri bundle configuration, CI/release workflows, and integration tests. Packaging/documentation preparation may overlap L and M; integration verification follows both.

1. Create `README.zh-CN.md` and English/Chinese user guides with reciprocal links, language-selection instructions, export behavior, installation steps, and known limitations. Review Chinese terminology in context for consistency and natural wording.
2. Put English and Chinese notes under each version's section in `CHANGELOG.md` using subheadings compatible with the existing extractor. Update `scripts/changelog-notes.mjs` and release checks to require nonempty sections for both languages on releases starting at v0.2.0, while still supporting historical v0.1.0 notes.
3. Configure NSIS languages and its selector, and WiX `en-US`/`zh-CN` outputs. Verify identifiers and supported translations against the installed Tauri toolchain. Ensure packaging globs, artifact names, size checks, and checksum generation include both MSI files without collisions. Reference: [Tauri Windows installer internationalization](https://v2.tauri.app/distribute/windows-installer/).
4. Keep the macOS universal build and existing application identifier. Verify installation, v0.1.0 upgrade, settings preservation, and uninstall on packaged Windows/macOS builds. Do not assume installer language sets app language.
5. Add catalog checks to CI and representative tests in both languages; exercise real exports in Chromium, Firefox, and WebKit, plus manual desktop checks on Windows and macOS and a Safari check on macOS.
6. Measure viewer, empty export, and installer size against existing budgets. If bilingual content exceeds a budget, record measured growth and justify any explicit budget revision before release; do not silently relax checks.

## 4. Integration and acceptance checklist

Create `docs/WAVE4_GATE.md` during implementation to record commands, results, artifact versions, manual environments, and remaining issues. These items are pending until supported by evidence:

- [ ] K contracts merged; both catalogs complete with matching interpolation parameters; unsupported/missing locale behavior tested.
- [ ] L and M integrated; both languages cover the app and exported viewer, including dynamic, error, and accessibility text.
- [ ] System detection, explicit override, restart/reload persistence, independent app/export choices, and project isolation pass.
- [ ] Repeated switching preserves processing, map/filter state, edits, and user content; blocked storage does not break switching.
- [ ] HTML and extracted folder/ZIP exports work from `file://`; all formats work over the local server, including serving ZIP directly. Offline language switching and Save a copy pass in both locales.
- [ ] Existing v0.1.0 settings/project fixtures migrate or load correctly; Chinese paths/titles round-trip; date grouping and machine-readable output remain unchanged.
- [ ] Existing Rust/frontend/E2E checks pass with bilingual coverage; size/performance gates pass or an evidence-backed budget change is recorded.
- [ ] Chinese translation and layout reviewed on narrow/mobile viewer sizes and the minimum desktop window; keyboard and screen-reader labels checked.
- [ ] Packaged NSIS, both MSI variants, and macOS DMG pass language, install/upgrade, and uninstall smoke checks; manual evidence covers Windows and macOS.
- [ ] English/Chinese README, guides, and release notes agree with shipped behavior; known platform-language limitations are explicit.
- [ ] Version files agree on 0.2.0; release artifacts, SHA-256 checksums, license notices, and corresponding-source bundle are complete.

## 5. Release sequence and future versions

1. Implement K, then L/M, integrate N, and close the checklist with evidence. Update the changelog as functionality lands; do not list planned features as already shipped.
2. Run the manual release workflow as a dry run and smoke-test its packaged artifacts. Resolve release-blocking issues before creating the version tag.
3. Synchronize version files for v0.2.0, prepare bilingual notes, and create the tag when release work is authorized. The existing workflow produces a draft release.
4. Verify the draft's artifacts and bilingual notes, then publish through the established release process. Record release completion in the roadmap and gate document.
5. For every later version, require both catalogs, localized new UI, bilingual notes, and representative tests for both languages before release. Continue shipping both languages under one version; track missing translations as release blockers rather than silently shipping an English-only new feature.

This planning change does not bump package versions, create a tag, or publish a release. If a regression is found after publication, record it and ship a new patch version with both languages; preserve already-published assets.
