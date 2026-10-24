# iPhone Photo GPS Map Tool - Project Memo

> **Last updated:** 2026-08-21  
> **Stack:** CesiumJS 1.119 + AppleScript + Python 3  
> **Use case:** Display a large collection of geotagged iPhone photos (1,000+) as a chronological route on a 3D map.

---

## 1. Project overview

This tool exports photos from macOS Photos.app for a selected date range, reads their EXIF GPS coordinates, and creates an interactive CesiumJS 3D map. Photos are ordered by capture time and connected as a route. The map supports thumbnail previews, date navigation, GPS outlier filtering, and manual location correction by dragging markers.

The project began after the author took more than 1,700 photos while working near Lake Baikal and needed a clear way to see the trip route and photo locations.

## 2. File structure

The project contains three application files plus this memo:

```
photo-way/
├── export_photos.sh        # Photo export (AppleScript + Bash)
├── gen_photo_map.py        # Photo-to-map generator (Python)
├── external_template.html  # Cesium 3D map template (HTML + JavaScript)
└── PROJECT_MEMO.md         # Project documentation
```

An export produces:

```
2026-07-23_2026-08-07/
├── photos/            # Original media files
├── thumbnails/        # Square 200px thumbnails with date labels
├── photos.json        # id, type, filename, datetime, timestamp, lat, lon, thumb, src, duration
└── index.html         # Copy of external_template.html; open through a local HTTP server
```

## 3. Core files

### 3.1 `export_photos.sh` - photo export

**Purpose:** Export photos from macOS Photos.app in date-based batches, then run `gen_photo_map.py`.

**Workflow:**

1. Ask for a start date and optional end date.
2. Export each day in batches of up to 100 items with AppleScript.
3. Retry a failed export up to twice, waiting longer each time and restarting Photos.app.
4. Generate thumbnails, `photos.json`, and `index.html`.
5. Start a local HTTP server for preview.

With an end date, the export runs through the range without further prompts. Without one, it prompts after each day. Enter or a 20-second timeout continues; `n`, `N`, or Esc stops. It also stops automatically at the current date.

**Implementation notes:**

- AppleScript's `with timeout of 7200 seconds` avoids the usual two-minute AppleEvent `-1712` timeout.
- Bash's `10#$MONTH` forces decimal parsing for months `08` and `09`.
- The AppleScript `do shell script` command avoids shell metacharacters such as parentheses.
- Progress is written to `/tmp/photo_export_progress.log`; monitor it with `tail -f`.
- Run the first export from Terminal.app so macOS can show the Photos automation permission prompt.

```bash
cd /path/to/project
bash export_photos.sh
# Enter the prompted dates and allow Photos automation when macOS asks.
```

### 3.2 `gen_photo_map.py` - map generator

**Purpose:** Scan media, read GPS metadata, generate thumbnails and `photos.json`, and copy the HTML template.

**Dependencies:**

- `exifread` reads photo EXIF GPS data.
- `Pillow` generates thumbnails.
- `pillow_heif` adds HEIC/HEIF support.
- macOS `mdls` reads video GPS metadata.
- macOS `qlmanage` extracts video preview frames.

Photo coordinates come from EXIF `GPSLatitude` and `GPSLongitude` in degrees, minutes, and seconds and are converted to decimal degrees. Video coordinates come from Spotlight metadata keys `kMDItemLatitude` and `kMDItemLongitude`. The latitude and longitude reference fields determine the coordinate signs.

Thumbnails are center-cropped to a 200 x 200px square by default, with capture time shown as white text on a dark lower bar. They are saved as JPEG at quality 85. Video previews use a frame extracted by `qlmanage`.

```bash
python3 gen_photo_map.py /path/to/photos --output /path/to/output_dir
# Optional: --thumb-size 200
```

Example `photos.json` item:

```json
[
  {
    "id": 0,
    "type": "photo",
    "filename": "IMG_0001.HEIC",
    "datetime": "2026:07:23 10:32:15",
    "timestamp": 1753257135,
    "lat": 53.123456,
    "lon": 108.234567,
    "thumb": "thumbnails/00000.jpg",
    "src": "photos/IMG_0001.HEIC",
    "duration": null
  }
]
```

### 3.3 `external_template.html` - Cesium map

This single HTML file contains the complete 3D interface and interaction logic. It is copied to the output as `index.html` and loads data with `fetch('./photos.json')`. CesiumJS 1.119 is loaded from a CDN.

## 4. Features

### 4.1 Basemaps

The `TILE_CONFIGS` configuration provides six options:

| Option | Source | Maximum zoom | Description |
|---|---|---:|---|
| Esri Satellite | `server.arcgisonline.com/World_Imagery` | 19 | Default worldwide satellite imagery |
| Satellite + Labels | Esri imagery + CartoDB labels | 19 | Satellite imagery with place names |
| Esri Topographic | `server.arcgisonline.com/World_Topo_Map` | 19 | Terrain and contours |
| OpenTopoMap | `tile.opentopomap.org` | 17 | Open-source topographic map (CC BY-SA) |
| OSM Standard | `tile.openstreetmap.org` | 19 | Standard OpenStreetMap tiles |
| Esri Streets | `server.arcgisonline.com/World_Street_Map` | 19 | Street map |

### 4.2 Photo markers

- Each geotagged photo appears as a thumbnail billboard.
- Markers face the camera and stay visible over terrain through `disableDepthTestDistance: Infinity`.
- Hovering shows filename, capture time, and coordinates.
- Dragging a marker corrects its GPS location. Corrections are saved by filename in browser `localStorage` and reapplied on reload.
- After a drag, outliers and the route are recalculated. Dragging farther than 5px suppresses the click that would otherwise open the full image.

### 4.3 Route

- Adjacent photos in time are connected with individual segments.
- The main route uses an 8px blue line (`#00BFFF`) at 2m height with `arcType: ArcType.NONE`.
- A red 12px direction arrow (`#ff2d2d`) spans 38%-62% of each segment at 3m height, above the main line.
- `PolylineArrowMaterialProperty` draws arrows. It cannot be combined with `clampToGround: true` because ground polylines do not support arrow material; explicit height and `ArcType.NONE` provide a similar appearance.
- Green **START** and red **END** markers show the route endpoints.
- Only the selected date's photos and route appear on the map.

### 4.4 Timeline

The bottom bar scrolls horizontally through photo thumbnails.

- Single-click a thumbnail to fly to and highlight its map location.
- Double-click to open the full-size modal, which supports previous/next navigation.
- A checkbox controls whether an item appears on the map and contributes to the route.
- Date separators show day, month, and year; clicking one toggles visibility for that entire day. Their dots indicate all, none, or some photos visible.
- Mouse wheel movement scrolls the timeline horizontally. Holding and dragging also scrolls it, with grab/grabbing cursors. Child clicks are suppressed only after a drag exceeds 5px.
- Suspect GPS items have a red dashed outline and warning badge. Manually corrected items have a pencil badge.

### 4.5 Date navigation

The timeline header includes previous/next day buttons, a date-list popover, and a visibility button for the selected day. At the start or end of the date range, the corresponding navigation button is disabled.

The date list shows each day's visibility dot, date, item count, and eye button. Clicking a row navigates to that day, flies the map, scrolls the timeline, and shows only that day's photos and route. Clicking its eye button changes visibility without closing the popover, so several days can be adjusted in sequence.

The selected day's eye button hides all when all are visible, shows all when none are visible, and shows all when only some are visible.

### 4.6 GPS outlier filtering

`computeSuspects()` sorts photos by time and calculates speed between consecutive coordinates. Segments above 300 km/h are abnormal. An isolated spike is flagged, while a run of at least three abnormal segments is treated as possible genuine high-speed travel (for example, a flight or high-speed train). The calculation runs again after a marker is dragged.

Filtering is on by default. Flagged photos are hidden from the map and omitted from the route, but remain visible with warning badges on the timeline. Turn filtering off to show them for manual correction.

Common sources of GPS error include indoor Wi-Fi location drift, an incomplete GPS cold start that records the last known position, and urban multipath effects.

### 4.7 Other controls

- **Route:** Show or hide the route and endpoint markers.
- **Filter GPS outliers:** Enable or disable outlier filtering.
- **Type:** Show all items, photos only, or videos only.
- **Zoom:** Set camera height from 500m to 50km.
- **2D/3D:** Switch between orthographic and perspective views.
- **Fit All:** Fit all visible photos in the view.
- **Full-size modal:** Navigate with left/right arrows; close with Esc or a click outside.

## 5. Architecture decisions

### 5.1 External data files

An early version embedded photo data directly in HTML, which could crash a browser with more than 1,700 photos. Now `photos.json` stores approximately 200KB of metadata, `thumbnails/` stores images that load on demand, and `index.html` fetches JSON asynchronously.

### 5.2 Thumbnail use

Map markers and the timeline use 200px thumbnails so thousands of 3-10MB originals do not fill browser memory. The full original is loaded only when opened in the modal.

### 5.3 Daily batches

Photos.app can hang when exporting a large collection at once. The script exports one day at a time in groups of 100, waits one second between batches, and retries a failed day twice after 5 and 10 seconds, restarting Photos.app before each retry.

### 5.4 Selected-date visibility

Switching dates hides all other days' map markers and routes. `isShownOnMap()` is the shared visibility filter for billboards, route drawing, and statistics.

### 5.5 Location corrections in `localStorage`

Drag corrections are keyed by filename in browser `localStorage` rather than written to `photos.json`. They are reapplied when the page loads and remain after regenerating the map.

## 6. Known issues and notes

1. **macOS TCC permission:** Run the script manually in Terminal.app on first use to trigger the Photos automation prompt. An agent or IDE sandbox may not show that prompt.
2. **AppleEvent timeout (`-1712`):** The 7,200-second timeout helps with large exports, but Photos.app can still hang. Retries restart the app.
3. **Arrow material limitation:** `PolylineArrowMaterialProperty` cannot be used with `clampToGround: true`. `fromDegreesArrayHeights` at 2m and `ArcType.NONE` approximate a ground-level route.
4. **Bash octal parsing:** Months `08` and `09` require `10#$MONTH` in arithmetic expressions.
5. **`do shell script` metacharacters:** Avoid unescaped shell syntax such as parentheses in the AppleScript-generated shell command.
6. **Cesium version:** The page uses 1.119 from a CDN. When upgrading, check `Viewer` constructor options and imagery provider APIs.

## 7. Extension guide

### 7.1 Add a basemap

Add an entry to `TILE_CONFIGS` in `external_template.html`, handle it in `setMapStyle()`, and add an option to `<select id="map-style-select">`:

```javascript
const TILE_CONFIGS = {
  // ... existing entries
  amap: {
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    maximumLevel: 18,
    credit: 'AutoNavi',
  },
};
```

Amap and Tencent tiles use GCJ-02 coordinates, while photo EXIF uses WGS-84. Convert coordinates before display to prevent offsets of tens or hundreds of meters. A China-only implementation can convert them in `addBillboards()`.

### 7.2 Change thumbnail size

```bash
python3 gen_photo_map.py /path/to/photos --output /path/to/output --thumb-size 300
```

Also adjust `.timeline-item` width and height in `external_template.html`. They are currently 120px for 200px thumbnails.

### 7.3 Add a media type

1. Add its extension to `IMAGE_EXTS` or `VIDEO_EXTS` in `gen_photo_map.py`.
2. Add an option to `<select id="filter-type">` in the HTML template.
3. Adjust marker styling in `addBillboards()`, such as a different badge color.

### 7.4 Export corrected coordinates

Corrections currently live only in `localStorage`. Run this in the browser console to inspect them, then write them back to `photos.json` or a separate file if needed:

```javascript
const fixes = JSON.parse(localStorage.getItem('photo_geo_fixes') || '{}');
console.log(JSON.stringify(fixes, null, 2));
```

### 7.5 Adjust the outlier threshold

Change `SPEED_THRESHOLD` in `computeSuspects()` (currently 300 km/h). A lower threshold catches more errors but may flag valid highway travel. A higher threshold flags only extreme cases and may miss moderate GPS drift.

### 7.6 Use another photo source

The export script works with macOS Photos.app. To use files from another source, place them in `photos/`, make sure filenames or EXIF provide capture dates, run `gen_photo_map.py`, and skip `export_photos.sh`.

## 8. Quick start

```bash
# 1. Run the export script in Terminal.
cd /path/to/project
bash export_photos.sh

# 2. Enter a date range when prompted.
#    Start date: 2026-07-23
#    End date:   2026-08-07 (or leave blank for daily prompts)

# 3. Wait for export (about 30-60 minutes for 1,700 photos).
#    Monitor progress in another terminal:
tail -f /tmp/photo_export_progress.log

# 4. The script generates the map and opens a browser preview.
#    If photos already exist, generate the map directly:
python3 gen_photo_map.py /path/to/photos --output /path/to/output

# 5. Serve the output over HTTP so the map can fetch photos.json.
cd /path/to/output
python3 -m http.server 8765
# Open http://localhost:8765/ in a browser.
```

## 9. Stack versions

| Component | Version | Purpose |
|---|---|---|
| CesiumJS | 1.119 (CDN) | 3D map engine |
| Python | 3.13+ | Generator script |
| exifread | Latest | EXIF GPS reading |
| Pillow | Latest | Thumbnail generation |
| pillow_heif | Latest | HEIC support |
| AppleScript | Built into macOS | Photos.app export |
| mdls | Built into macOS | Video metadata reading |
| qlmanage | Built into macOS | Video preview frame extraction |

## 10. Cross-platform and alternative approaches

### 10.1 Android photo export

The current export depends on macOS Photos.app and AppleScript. Android needs a different export method.

#### Option A: Python and ADB

This is closest to the existing architecture and requires no phone-side app. Pull files with ADB, then process them locally:

```bash
adb pull /sdcard/DCIM/Camera/ ./photos/      # Camera photos
adb pull /sdcard/DCIM/Screenshots/ ./photos/ # Screenshots
adb pull /sdcard/Pictures/ ./photos/         # Other images
```

`gen_photo_map.py` can already read GPS EXIF from JPEG and HEIC photos. For Android video GPS, replace macOS `mdls` with `ffprobe` or a metadata library such as `hachoir`.

Implementation steps:

1. Add an `export_android.sh` using `adb pull` and date filtering.
2. Read video GPS with `ffprobe -v quiet -print_format json -show_format <file>`.
3. Select files by date using device filenames or `adb shell stat` timestamps.

#### Option B: Native Android app

For a standalone phone app, Kotlin is the preferred language. Query photos by date with `MediaStore.Images.Media`, read GPS with `android.media.ExifInterface`, generate thumbnails with MediaStore or `BitmapFactory`, display a map with MapLibre/Mapbox or Amap Android SDK, and store metadata in Room or JSON.

```kotlin
val exif = ExifInterface(file.absolutePath)
val lat = exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE)  // DMS, e.g. "51/1,30/1,12/1"
val latRef = exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE_REF)  // "N" or "S"
// Convert DMS to decimal degrees as in gen_photo_map.py.
```

```kotlin
val projection = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN)
val selection = "${MediaStore.Images.Media.DATE_TAKEN} >= ? AND ${MediaStore.Images.Media.DATE_TAKEN} <= ?"
val args = arrayOf(startTimestamp.toString(), endTimestamp.toString())
val cursor = contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, selection, args, null)
```

#### Option C: Flutter or React Native

Flutter can combine `photo_manager`, `exif`, and `flutter_map` or `google_maps_flutter`. React Native can combine `react-native-photo-library`, `react-native-exif`, and `react-native-maps`. One codebase can cover Android and iOS, though its 3D map options may differ from Cesium.

| Factor | A: ADB | B: Native app | C: Cross-platform app |
|---|---|---|---|
| Development effort | Lowest; adapt scripts | Highest; build an app | Medium; shared code |
| User experience | Requires a computer | Runs on the phone | Runs on the phone |
| 3D map | Same Cesium output | Depends on SDK | Depends on plugin |
| Best fit | Quick validation | Long-term product | Android and iOS support |

### 10.2 Alternative map engines

| Engine | Strength | Typical use | Coordinates |
|---|---|---|---|
| Leaflet | Small and easy to learn | Simple 2D maps, fewer than 500 photos | WGS-84; convert for GCJ-02 tiles |
| OpenLayers | More projections and GIS features | Complex 2D operations | WGS-84 supported |
| MapLibre GL JS | Open-source vector maps and 3D terrain | Larger projects with 3D effects | WGS-84 supported |
| Mapbox GL JS | Polished commercial maps | Strong visual design | WGS-84 supported |
| deck.gl | Data visualization on Mapbox/MapLibre | Heatmaps and large point sets | WGS-84 supported |

For Leaflet, use `L.marker()` with thumbnail icons, `L.polyline()` with an arrow decorator, and `L.tileLayer()` for basemaps. It has no 3D terrain but can offer simpler mobile interactions.

For MapLibre, use symbol or custom HTML markers, a line layer plus arrow symbol layer, a style JSON basemap, and `map.setTerrain({ source: 'terrainSource' })` for 3D. With more than 1,700 markers, consider GeoJSON clustering or incremental loading.

For China-focused maps, Amap and Tencent use GCJ-02, Baidu uses BD-09, and Tianditu uses CGCS2000 (close to WGS-84). Amap offers broad local data and 3D support; convert EXIF WGS-84 coordinates before displaying markers and route lines. Amap markers use `AMap.Marker()` and route lines use `AMap.Polyline()`.

A practical selection guide:

```
Need 3D terrain and worldwide satellite imagery?
├─ Yes: Need an open-source engine?
│       ├─ Yes: MapLibre GL JS
│       └─ No: Mapbox GL JS or keep Cesium
└─ No: Mainly used in China?
        ├─ Yes: Amap JS API with coordinate conversion
        └─ No: Fewer than 500 photos?
                ├─ Yes: Leaflet
                └─ No: MapLibre GL JS
```

### 10.3 Alternative tile sources for Cesium

Add a tile source to `TILE_CONFIGS` without replacing Cesium:

| Source | URL template | Max zoom | Coordinates | Notes |
|---|---|---:|---|---|
| Tianditu satellite | `https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&...` | 18 | WGS-84 | Requires an API key |
| Tianditu vector | `https://t{s}.tianditu.gov.cn/vec_w/wmts?...` | 18 | WGS-84 | Requires an API key |
| Amap satellite | `https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}` | 18 | GCJ-02 | Convert coordinates |
| Amap vector | `https://webrd0{s}.is.autonavi.com/appmaptile?lang=en&size=1&scale=1&style=8&x={x}&y={y}&z={z}` | 18 | GCJ-02 | Convert coordinates |
| Google satellite | `https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}` | 21 | WGS-84 | Unofficial access may be rate limited |
| Google vector | `https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}` | 21 | WGS-84 | Same access caveat |
| Mapbox satellite | `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.png?access_token={token}` | 22 | WGS-84 | Requires a token |
| Offline tiles | `./tiles/{z}/{x}/{y}.png` | Varies | Source dependent | Works without network |

For offline tiles, download the desired region with TileMill or MOBAC, save tiles in `tiles/{z}/{x}/{y}.png` under the output directory, and set `maximumLevel` to the highest downloaded zoom level. Then the map can work on a laptop without a network connection.

### 10.4 Coordinate conversion

| Source | Target | Conversion | Applicable tiles |
|---|---|---|---|
| WGS-84 (EXIF) | GCJ-02 | `wgs84togcj02()` | Amap, Tencent |
| WGS-84 | BD-09 | `wgs84tobd09()` via GCJ-02 | Baidu |
| WGS-84 | WGS-84 | None | Cesium, Leaflet, Tianditu, Google |

Keep original WGS-84 coordinates in `photos.json` and convert at display time. If users can switch among tile systems, `setMapStyle()` should determine when to transform marker and route coordinates.

---

For implementation details, read the source comments alongside this memo.
