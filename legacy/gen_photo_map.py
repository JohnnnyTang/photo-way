#!/usr/bin/env python3
"""
Photo map generator (external-file mode).
Scan a photo directory and generate:
  1. thumbnails/  - JPEG thumbnail files
  2. photos.json  - Photo metadata (date, coordinates, file paths, etc.)
  3. index.html   - Cesium 3D map (loads data from photos.json)

Usage:
  python gen_photo_map.py /path/to/photos --output /path/to/output_dir
  python gen_photo_map.py /path/to/photos --output /path/to/output_dir --thumb-size 200
"""

import argparse
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import exifread
from PIL import Image, ImageDraw, ImageFont
import pillow_heif

pillow_heif.register_heif_opener()

IMAGE_EXTS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".tiff", ".tif"}
VIDEO_EXTS = {".mov", ".mp4", ".m4v"}


# ═══════════════════════════════════════════════════════════
#  EXIF / metadata extraction
# ═══════════════════════════════════════════════════════════

def _ratio_to_float(value):
    if isinstance(value, exifread.utils.Ratio):
        return float(value.num) / float(value.den) if value.den != 0 else 0.0
    return float(value)


def get_photo_gps(filepath):
    """Extract GPS coordinates and capture time from photo EXIF. Return (lat, lon, dt_str) or None."""
    try:
        with open(filepath, "rb") as f:
            tags = exifread.process_file(f, details=False)
    except Exception:
        return None

    gps_lat = tags.get("GPS GPSLatitude")
    gps_lat_ref = tags.get("GPS GPSLatitudeRef")
    gps_lon = tags.get("GPS GPSLongitude")
    gps_lon_ref = tags.get("GPS GPSLongitudeRef")
    if not gps_lat or not gps_lon:
        return None

    def dms_to_dec(dms_tag, ref_tag):
        parts = dms_tag.values
        deg = _ratio_to_float(parts[0])
        minute = _ratio_to_float(parts[1])
        sec = _ratio_to_float(parts[2])
        dec = deg + minute / 60.0 + sec / 3600.0
        if ref_tag and str(ref_tag.values) in ("S", "W"):
            dec = -dec
        return dec

    lat = dms_to_dec(gps_lat, gps_lat_ref)
    lon = dms_to_dec(gps_lon, gps_lon_ref)

    dt_str = ""
    dt_tag = tags.get("EXIF DateTimeOriginal") or tags.get("EXIF DateTime")
    if dt_tag:
        dt_str = str(dt_tag.values).strip()

    return lat, lon, dt_str


def get_video_metadata(filepath):
    """Extract video GPS, creation time, and duration with macOS mdls."""
    try:
        result = subprocess.run(
            ["mdls", "-raw", filepath],
            capture_output=True, text=True, timeout=10
        )
    except Exception:
        return None

    metadata = {}
    for line in result.stdout.split("\n"):
        if "=" in line:
            parts = line.split("=", 1)
            key = parts[0].strip()
            val = parts[1].strip().strip('"')
            metadata[key] = val

    lat = metadata.get("kMDItemLatitude")
    lon = metadata.get("kMDItemLongitude")
    date_str = metadata.get("kMDItemContentCreationDate")
    duration = metadata.get("kMDItemDurationSeconds")

    lat = float(lat) if lat and lat != "(null)" else None
    lon = float(lon) if lon and lon != "(null)" else None
    duration = float(duration) if duration and duration != "(null)" else None

    if lat is None or lon is None:
        return None

    return lat, lon, date_str, duration


# ═══════════════════════════════════════════════════════════
#  Thumbnail generation (saved as files)
# ═══════════════════════════════════════════════════════════

def _load_font(size):
    font_paths = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/SFNSDisplay.ttf",
        "/System/Library/Fonts/SFNSMono.ttf",
    ]
    for path in font_paths:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _format_datetime_label(dt_str):
    dt = parse_datetime(dt_str)
    if dt:
        return dt.strftime("%m-%d %H:%M")
    return dt_str[:16].replace(":", "-") if dt_str else ""


def save_image_thumbnail(filepath, thumb_path, size=200, datetime_str=""):
    """Generate a square thumbnail and save it as a JPEG file."""
    try:
        img = Image.open(filepath)
        min_dim = min(img.width, img.height)
        left = (img.width - min_dim) / 2
        top = (img.height - min_dim) / 2
        img = img.crop((left, top, left + min_dim, top + min_dim))
        img = img.resize((size, size), Image.LANCZOS)

        label = _format_datetime_label(datetime_str)
        bar_h = max(20, size // 7)

        total_h = size + bar_h
        canvas = Image.new("RGB", (size, total_h), (0, 0, 0))
        canvas.paste(img, (0, 0))

        canvas_rgba = canvas.convert("RGBA")
        overlay = Image.new("RGBA", (size, bar_h), (0, 0, 0, 200))
        canvas_rgba.paste(overlay, (0, size), overlay)

        draw = ImageDraw.Draw(canvas_rgba)
        font_size = max(11, size // 12)
        font = _load_font(font_size)
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        text_x = (size - text_w) / 2
        text_y = size + (bar_h - text_h) / 2 - bbox[1]
        draw.text((text_x, text_y), label, fill=(255, 255, 255, 255), font=font)

        img = canvas_rgba.convert("RGB")
        img.save(thumb_path, format="JPEG", quality=85)
        return True
    except Exception as e:
        print(f"  ⚠️ Thumbnail generation failed: {filepath.name} - {e}", file=sys.stderr)
        return False


def save_video_thumbnail(filepath, thumb_path, size=200, datetime_str=""):
    """Extract a video preview frame with macOS qlmanage and save it as JPEG."""
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            subprocess.run(
                ["qlmanage", "-t", "-s", str(size * 2), "-o", tmpdir, filepath],
                capture_output=True, timeout=15
            )
            thumb_name = os.path.basename(filepath) + ".png"
            thumb_path_tmp = os.path.join(tmpdir, thumb_name)
            if os.path.exists(thumb_path_tmp):
                return save_image_thumbnail(thumb_path_tmp, thumb_path, size, datetime_str)
    except Exception:
        pass
    return False


# ═══════════════════════════════════════════════════════════
#  Date and time parsing
# ═══════════════════════════════════════════════════════════

def parse_datetime(dt_str):
    if not dt_str:
        return None
    for fmt in [
        "%Y:%m:%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S +0000",
        "%Y-%m-%dT%H:%M:%SZ",
    ]:
        try:
            return datetime.strptime(dt_str, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════
#  Directory scanning and thumbnail/JSON generation
# ═══════════════════════════════════════════════════════════

def scan_and_generate(photo_dir, output_dir, thumb_size=200):
    """Scan the photo directory and generate thumbnails and photos.json."""
    thumb_dir = os.path.join(output_dir, "thumbnails")
    os.makedirs(thumb_dir, exist_ok=True)

    items = []
    total = 0
    with_gps = 0
    no_gps = 0
    idx = 0

    for filepath in sorted(Path(photo_dir).rglob("*")):
        ext = filepath.suffix.lower()
        if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
            continue

        total += 1
        fpath = str(filepath)

        if ext in IMAGE_EXTS:
            gps = get_photo_gps(fpath)
            if not gps:
                no_gps += 1
                continue
            lat, lon, dt_str = gps
            item_type = "photo"
            duration = None
        else:
            vmeta = get_video_metadata(fpath)
            if not vmeta:
                no_gps += 1
                continue
            lat, lon, dt_str, duration = vmeta
            item_type = "video"

        dt = parse_datetime(dt_str)

        # Generate a thumbnail file.
        thumb_name = f"{idx:05d}.jpg"
        thumb_path = os.path.join(thumb_dir, thumb_name)
        thumb_rel = f"thumbnails/{thumb_name}"

        if item_type == "photo":
            ok = save_image_thumbnail(fpath, thumb_path, thumb_size, dt_str)
        else:
            ok = save_video_thumbnail(fpath, thumb_path, thumb_size, dt_str)

        if not ok:
            thumb_rel = None

        # Relative path to the original image (for the full-size modal).
        # The HTML page loads this relative path over HTTP.
        src_rel = "photos/" + quote(filepath.name)

        items.append({
            "id": idx,
            "type": item_type,
            "filename": filepath.name,
            "datetime": dt_str,
            "timestamp": dt.timestamp() if dt else 0,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "thumb": thumb_rel,
            "src": src_rel,
            "duration": round(duration, 1) if duration else None,
        })
        with_gps += 1
        idx += 1

        if idx % 50 == 0:
            print(f"  Processed {idx} GPS-tagged items...")

    return items, total, with_gps, no_gps


# ═══════════════════════════════════════════════════════════
#  Main entry point
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Photo map generator (external-file mode) - generates thumbnails, photos.json, and index.html",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  %(prog)s ~/Downloads/2025-07-23_2025-08-07/photos --output ~/Downloads/2025-07-23_2025-08-07
        """
    )
    parser.add_argument("directory", help="Directory containing photos and videos")
    parser.add_argument("--output", "-o", required=True,
                        help="Output directory (contains thumbnails/, photos.json, and index.html)")
    parser.add_argument("--thumb-size", type=int, default=200,
                        help="Thumbnail size in pixels (default: 200)")
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"❌ Directory does not exist: {args.directory}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    print(f"📂 Scanning directory: {args.directory}")
    print(f"📁 Output directory: {args.output}")
    print(f"🖼️  Thumbnail size: {args.thumb_size}px")
    print()

    items, total, with_gps, no_gps = scan_and_generate(
        args.directory, args.output, args.thumb_size
    )

    print()
    print(f"  Total files:           {total}")
    print(f"  With GPS coordinates:  {with_gps}")
    print(f"  Without GPS (skipped): {no_gps}")
    print()

    if not items:
        print("❌ No photos or videos with GPS information were found.", file=sys.stderr)
        sys.exit(1)

    # Write photos.json.
    json_path = os.path.join(args.output, "photos.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    json_size = os.path.getsize(json_path) / 1024
    print(f"✅ Generated photos.json ({json_size:.0f} KB)")

    # Copy the HTML template.
    template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "external_template.html")
    if not os.path.exists(template_path):
        print(f"❌ Template file does not exist: {template_path}", file=sys.stderr)
        sys.exit(1)

    html_path = os.path.join(args.output, "index.html")
    shutil.copy2(template_path, html_path)
    print("✅ Generated index.html")

    # Calculate thumbnail directory size.
    thumb_dir = os.path.join(args.output, "thumbnails")
    thumb_count = len([f for f in os.listdir(thumb_dir) if f.endswith(".jpg")])
    thumb_size_mb = sum(
        os.path.getsize(os.path.join(thumb_dir, f))
        for f in os.listdir(thumb_dir)
    ) / 1024 / 1024
    print(f"✅ Thumbnails: {thumb_count} files ({thumb_size_mb:.1f} MB)")

    print()
    print("📋 Output directory structure:")
    print(f"   {args.output}/")
    print(f"   ├── index.html")
    print(f"   ├── photos.json")
    print(f"   └── thumbnails/")
    print(f"       └── {thumb_count} thumbnail files")
    print()
    print("💡 Preview: start an HTTP server in the output directory, then open it in a browser:")
    print(f"   cd {args.output}")
    print(f"   python3 -m http.server 8765")
    print("   Then visit http://localhost:8765/")


if __name__ == "__main__":
    main()
