# Wave 3 gate

## Release smoke (I)

`.github/workflows/release-smoke.yml` plus `scripts/release-smoke.mjs` install and run the real v0.1.0 draft
release assets on clean hosted runners. See `docs/RELEASING.md` for how and when to run it.

### Results (v0.1.0 draft, branch `wave3/i-release`)

| Run | Windows (windows-latest) | macOS arm64 (macos-latest) | macOS x64 (macos-15-intel) |
|---|---|---|---|
| 40103044338 (first) | 43/51; failed: checksum names, MSI location assumption | 36/42; failed: checksum names only | 36/42; failed: checksum names only |
| 40103213620 | green | green | green |

What is checked and passed in the final run:

- `SHA256SUMS.txt` matches every asset, and every asset is covered.
- Windows NSIS (`/S`, per user) and MSI (`/qn`), installed one after the other: exe present, Start Menu shortcut,
  uninstall registry entry, licence files bundled, exe file and product version `0.1.0`, app alive with a window
  (`MainWindowHandle` non-zero) after 10 s, silent uninstall removes files, shortcut and registry entry.
- macOS dmg: mounts, `.app` copies out, `CFBundleShortVersionString` 0.1.0, app binary and CLI both
  `arm64 x86_64`, ad-hoc signature (`flags=adhoc,runtime`) verifies with `--deep --strict`, bundle binary alive after
  10 s on both arm64 and Intel runners, notices in Resources, dmg detaches.
- CLI on both OSes: `--version` is `photoway 0.1.0`; `inspect` finds the 12 generated photos; `build` for html, dir
  and zip; `serve` answers 200 for the index.
- File associations: none registered. No extension keys appear in HKCU/HKLM Classes after either installer, and
  `Info.plist` has no `CFBundleDocumentTypes`.

### Findings

1. **Installer asset names broke `SHA256SUMS.txt` (fixed for v0.1.1).** Tauri names installers `Photo Way_0.1.0_...`;
   GitHub renames spaces to dots on upload, so `sha256sum -c` against the originally generated file failed for
   the three installers. (The v0.1.0 draft's checksum file was corrected by hand afterwards.) Fix in
   `release.yml` Package step: copy installers with spaces replaced by `-`.
2. **MSI installs per user files with a machine-wide registry entry (observation, not changed).** The MSI puts files in
   `%LOCALAPPDATA%\Photo Way` while the uninstall entry is under HKLM and the shortcut under
   `%ProgramData%`. Install and uninstall work, but it is an unusual mix. Review before v0.2 whether the MSI should be
   a real per-machine install.
3. No other bugs: version stamping, universal slices, signatures, launch and uninstall behave as intended.

### Not covered

- The macOS app was only launched, not driven; the full export flow on macOS remains a hand check
  (`docs/RELEASING.md`).
- Unsigned build warnings (SmartScreen, Gatekeeper) are not testable on hosted runners.
- Installer sizes (v0.1.0): NSIS 3.1 MB, MSI 4.4 MB, dmg 8.0 MB; budget 15 MB each.
