# Legacy scripts

These are the scripts Photo Way grew out of. **You do not need them to use the app.**

| File | Status |
|---|---|
| `export_photos.sh` | Optional helper for macOS users who keep photos in the Photos app |
| `gen_photo_map.py`, `external_template.html` | Reference only. Replaced by the app and the `photoway` CLI |

## export_photos.sh: export a date range from Photos on macOS

Photos on a Mac does not let you drag a whole date range out to a folder in one step.
This script asks Photos (through AppleScript) to export a date range one day at a time, in batches of 100
so that Photos does not hang on a large export. You can then drop the resulting folder into Photo Way.

Requirements:

- macOS with the Photos app and your library in it
- `bash`, `osascript` (both ship with macOS)
- `python3`, used only for date arithmetic and, in the old workflow, the last step (see below).
  Set `PYTHON=/path/to/python3` to choose another interpreter.
- On first run, macOS asks whether Terminal may control Photos. Allow it.

Usage:

```sh
cd ~/Desktop            # the output folder is created in the current directory
bash /path/to/photo-way/legacy/export_photos.sh
```

It asks for a start date and an optional end date (`YYYY-MM-DD`).

- With an end date, it exports every day through that date without stopping.
- Without one, it asks after each day whether to continue (Enter continues; so does 20 seconds of silence; `n` stops).
- A failed day is retried twice, restarting Photos in between. Rerun a day later to fill gaps.

The photos land in `START_END/photos/`. Progress can be followed from another terminal with
`tail -f /tmp/photo_export_progress.log`.

Then drop `START_END/photos/` into Photo Way. Run `photoway inspect START_END/photos` first if you want
to confirm that the exported files still carry their location.

### The old map step

After exporting, the script also runs `gen_photo_map.py`, which needs
`pip install exifread Pillow pillow_heif`, writes thumbnails, `photos.json` and a Cesium `index.html`,
and starts a local server on port 8765. You can ignore that output: Photo Way replaces this step.

## gen_photo_map.py and external_template.html

The original generator: a Python script that read EXIF GPS with `exifread`, made thumbnails, and filled a
CesiumJS 3D map page that needed a web server (it loaded `photos.json` with `fetch`, so it did not work from
`file://`). They are kept as a reference for the original behaviour (the 300 km/h outlier rule, day navigation,
drag-to-correct) which the new viewer reimplements. They are not maintained and not part of the release.
