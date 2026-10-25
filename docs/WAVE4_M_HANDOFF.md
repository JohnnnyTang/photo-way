# Wave 4 session M handoff

Branch: `codex/wave4-session-m` (managed worktree `wave4-viewer-cli`). This branch starts at the v0.1.1 Wave 3 baseline and includes the Wave 4 locale and project-model prerequisites copied from stream K. Review those overlapping files when K, L, M, and N are integrated.

## Behavior

- The exported viewer offers **More → Language / 语言 → English / 简体中文**. A manual choice is stored by project ID. Without a saved choice, the viewer uses a supported embedded `options.lang`, then browser language, then English. An explicit unsupported embedded value falls back to English.
- Language changes redraw controls, dates, trip statistics, timeline rows, modal information, and accessible labels while keeping the map, selection, edits, filters, and Save a copy options mounted. Switching works when storage is blocked.
- Save a copy embeds the currently selected language in `options.lang`. The folder and ZIP README is bilingual. Both language catalogs are part of the bundled viewer; switching requires no network request.
- The CLI accepts `photoway build <INPUTS>... -o <OUT> --lang en|zh-CN`. English is the default for existing CLI usage. Other values are rejected by Clap with the supported choices. The flag applies to HTML, folder, and ZIP exports and does not change machine-readable output.

## Verification on 2026-10-24

- `npm run typecheck -w viewer` and `npm run test -w viewer`: passed, 31 unit tests.
- `cargo test -p photoway-cli -p photoway-core`: passed, including CLI parser, old project compatibility, and bundle/serve tests. Used the existing `D:\code\vcpkg-pw` checkout.
- Actual CLI exports, rather than reference layouts: Chromium, Firefox, and WebKit passed language switching for HTML, folder, and extracted ZIP over `file://` and HTTP (18 cases). Save a copy with a Chinese default and edits passed for HTML over both transports (6 cases).
- Offline switching with blocked storage passed in all three browsers. The reference single-file page passed selection, option preservation, reload, and Save a copy checks in all three browsers.
- `photoway build ... --lang zh-CN` produced an HTML export with `"lang":"zh-CN"`; `--lang fr` returned a supported-values error.
- `node scripts/check-size.mjs`: viewer JS+CSS 1731.1 KiB / 468.9 KiB gzip, empty shell 2312.6 KiB, all within existing budgets. Installer packaging is stream N's scope.

The final integration recheck should build the desktop app with L's export-language selection and run N's packaging and release gates after the branches are combined.
