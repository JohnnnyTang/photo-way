# Wave 1 integration gate — 2026-10-24

The four Wave 1 branches have been integrated into `main`. Metadata and CI/release arrived through PRs #1 and #2; Media and Viewer were merged locally after review. This record distinguishes checks run on the integrated tree from checks that still need hosted runners.

| Gate | Evidence | Status |
|---|---|---|
| Metadata and media fixtures | `cargo test -p photoway-core` on Windows with the pinned vcpkg libheif installation: 18 unit, 13 media, and 19 scan tests passed, including HEIC, EXIF orientation, video posters, cache recovery, Live Photo pairing, and UTC/local-day ordering. | Passed locally |
| Viewer tests | `npm run typecheck -w viewer`, `npm run test -w viewer` (5 tests), and `npm run test:e2e -w viewer` with local Chromium and WebKit browsers (9 passed, 1 intentionally skipped WebKit-only scale case). Tests open both output layouts through `file://`. | Passed locally |
| Size budgets | `viewer.js` + CSS: 1,700.3 KiB / 458.4 KiB gzip (limits 1,843.2 / 480); offline basemap: 580.8 KiB (limit 600); empty HTML shell: 2,281.9 KiB (limit 2,662.4). The basemap is an inline JSON script in the HTML so it remains available under `file://` while being measured separately. | Passed locally |
| Format, static checks, notices | `cargo fmt --all --check`, `node scripts/check-text.mjs`, `node scripts/version-sync.mjs --check`, and `node scripts/third-party-notices.mjs --check` passed. | Passed locally |
| Cross-platform and release | Hosted CI must complete on Windows, macOS, and Ubuntu after push. Installer creation, macOS universal linking, source tarball, and binary import assertions cannot be confirmed from this Windows checkout alone. | Pending hosted CI / release dry run |
| 1,000 × 12 MP HEIC throughput | The benchmark harness is present, but the committed HEIC fixture is 640×480 and cannot validate the plan's under-60-second target. Run it with a representative `PW_BENCH_DIR` of 12 MP HEICs. | Pending representative input |

Wave 2 can build against the merged contracts. Its final exit still depends on the hosted and performance checks above.
