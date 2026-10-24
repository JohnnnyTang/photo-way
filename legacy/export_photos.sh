#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Photo export and map generation script (batched export)
#
#  Export photos from Photos.app one day at a time in batches of 100
#  to prevent the app from hanging during a large export.
#
#  Usage: run bash export_photos.sh from any directory.
#  - With an end date: export each day automatically through that date.
#  - Without an end date: ask after each day whether to continue.
#
#  Output directory structure:
#    START_DATE_END_DATE/
#    ├── photos/        - Original photos
#    ├── thumbnails/    - JPEG thumbnails
#    ├── photos.json    - Metadata (dates and coordinates)
#    └── index.html     - Cesium 3D map
# ═══════════════════════════════════════════════════════════

# Directory containing this script (and gen_photo_map.py).
WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Python interpreter with exifread, Pillow, and pillow_heif installed; override with PYTHON=/path/to/python3.
PYTHON="${PYTHON:-python3}"
BATCH_SIZE=100

MONTH_NAMES=("January" "February" "March" "April" "May" "June" "July" "August" "September" "October" "November" "December")

# ── Helper: advance one day ──
next_date() {
    "$PYTHON" -c "from datetime import datetime,timedelta; d=datetime.strptime('$1','%Y-%m-%d'); print((d+timedelta(days=1)).strftime('%Y-%m-%d'))"
}

# ── Helper: export one day's photos in batches ──
# Arguments: $1=date string (YYYY-MM-DD)  $2=photo output directory
# Output: photo count on the last line of stdout
export_one_day() {
    local DATE_STR="$1"
    local PHOTO_DIR="$2"

    local YEAR=$(echo "$DATE_STR" | cut -d'-' -f1)
    local MONTH=$(echo "$DATE_STR" | cut -d'-' -f2)
    local DAY=$(echo "$DATE_STR" | cut -d'-' -f3)
    # Force base 10 so Bash does not interpret 08/09 as invalid octal numbers.
    local MONTH_NAME="${MONTH_NAMES[$((10#$MONTH - 1))]}"

    # AppleEvent's default two-minute timeout can trigger -1712 for large exports.
    # Extend it to two hours and log progress after each batch.
    rm -f /tmp/photo_export_progress.log
    osascript 2>&1 << APPLESCRIPT
tell application "Photos"
    activate
    delay 1

    with timeout of 7200 seconds
        -- Set the day's range from 00:00:00 through 23:59:59.
        set startDate to current date
        set day of startDate to $DAY
        set month of startDate to $MONTH_NAME
        set year of startDate to $YEAR
        set time of startDate to 0

        set endDate to current date
        set day of endDate to $DAY
        set month of endDate to $MONTH_NAME
        set year of endDate to $YEAR
        set time of endDate to 86399

        set resultPhotos to (every media item whose (date of it >= startDate) and (date of it <= endDate))
        set photoCount to count of resultPhotos

        if photoCount is 0 then
            return "0"
        end if

        set exportFolder to POSIX file "$PHOTO_DIR"

        -- Export in batches of at most $BATCH_SIZE items.
        set batchStart to 1
        set batchNo to 1
        repeat while batchStart <= photoCount
            set batchEnd to batchStart + $BATCH_SIZE - 1
            if batchEnd > photoCount then
                set batchEnd to photoCount
            end if

            set batchPhotos to items batchStart thru batchEnd of resultPhotos
            export batchPhotos to exportFolder

            -- Write progress to a log that can be tailed from the shell.
            -- Avoid shell metacharacters such as parentheses in do shell script.
            do shell script "echo batch " & batchNo & " done - " & batchEnd & "/" & photoCount & " >> /tmp/photo_export_progress.log"
            set batchNo to batchNo + 1
            set batchStart to batchEnd + 1
            delay 1
        end repeat
    end timeout

    return (photoCount as string)
end tell
APPLESCRIPT
}

# ═══════════════════════════════════════════════════════════
#  Main workflow
# ═══════════════════════════════════════════════════════════

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Photo Export and Map Generator         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  - Export one day at a time in batches of ${BATCH_SIZE}"
echo "  - With an end date, continue automatically through that date"
echo "  - Without an end date, ask after each day; continue after 20 seconds"
echo "  - Retry failed exports automatically"
echo ""

# ── 1. Ask for dates ──
read -p "Start date (YYYY-MM-DD, e.g. 2026-07-23): " START_DATE
read -p "End date (YYYY-MM-DD; leave blank to decide after each day): " END_DATE
echo ""

if [ -n "$END_DATE" ]; then
    echo "  Date range: $START_DATE ~ $END_DATE (automatic export)"
    OUTPUT_DIR="$(pwd)/${START_DATE}_${END_DATE}"
else
    echo "  Start date: $START_DATE (prompt after each day; auto-continue after 20 seconds)"
    OUTPUT_DIR="$(pwd)/${START_DATE}"
fi

PHOTO_DIR="$OUTPUT_DIR/photos"
mkdir -p "$PHOTO_DIR"
echo "  Output directory: $OUTPUT_DIR"
echo ""

# ── 2. Export by day ──
echo "[1/3] Exporting photos from Photos.app in batches..."
echo "      ⚠️  On the first run, approve the Photos automation permission prompt."
echo "      💡  For large exports, monitor progress from another terminal:"
echo "          tail -f /tmp/photo_export_progress.log"
echo ""

CURRENT_DATE="$START_DATE"
LAST_DATE="$START_DATE"
TOTAL_EXPORTED=0
DAY_COUNT=0

while true; do
    echo "  ── $CURRENT_DATE ──"

    FILES_BEFORE=$(ls "$PHOTO_DIR" 2>/dev/null | wc -l | tr -d ' ')

    RESULT=$(export_one_day "$CURRENT_DATE" "$PHOTO_DIR")
    DAY_NUM=$(echo "$RESULT" | tail -1 | tr -d ' \n\r')

    # Retry failures twice, with increasing wait times.
    RETRY=0
    MAX_RETRY=2
    while ! [[ "$DAY_NUM" =~ ^[0-9]+$ ]] && [ "$RETRY" -lt "$MAX_RETRY" ]; do
        RETRY=$((RETRY + 1))
        WAIT=$((RETRY * 5))
        echo "    ⚠️ Export failed (retry $RETRY of $MAX_RETRY); waiting ${WAIT} seconds..."
        echo "       Error: $(echo "$RESULT" | tail -1)"
        sleep "$WAIT"
        # Restart Photos before retrying; it may still export after a -1712 timeout.
        killall Photos 2>/dev/null
        sleep 3
        open -a Photos
        sleep 8
        RESULT=$(export_one_day "$CURRENT_DATE" "$PHOTO_DIR")
        DAY_NUM=$(echo "$RESULT" | tail -1 | tr -d ' \n\r')
    done

    if [[ "$DAY_NUM" =~ ^[0-9]+$ ]] && [ "$DAY_NUM" -gt 0 ]; then
        # Calculate the number of batches.
        BATCHES=$(( (DAY_NUM + BATCH_SIZE - 1) / BATCH_SIZE ))
        echo "    Exported: $DAY_NUM items ($BATCHES batches)"
        TOTAL_EXPORTED=$((TOTAL_EXPORTED + DAY_NUM))
        # Check the file-count increase; repeat exports can overwrite namesakes.
        FILES_AFTER=$(ls "$PHOTO_DIR" 2>/dev/null | wc -l | tr -d ' ')
        NEW_FILES=$((FILES_AFTER - FILES_BEFORE))
        if [ "$NEW_FILES" -lt "$DAY_NUM" ]; then
            if [ "$NEW_FILES" -le 0 ]; then
                echo "    ⚠️ Reported $DAY_NUM exports, but no new files appeared (some batches may have timed out)"
            else
                echo "    ⚠️ Reported $DAY_NUM exports; found $NEW_FILES new files (rerun this day if batches timed out)"
            fi
        fi
    elif [[ "$DAY_NUM" =~ ^[0-9]+$ ]] && [ "$DAY_NUM" -eq 0 ]; then
        echo "    No photos for this day"
    else
        echo "    ❌ Failed after $MAX_RETRY retries; skipping this day"
        echo "       Error: $RESULT"
        echo "       Tip: rerun this date later to fill gaps (matching filenames will be overwritten)"
    fi

    LAST_DATE="$CURRENT_DATE"
    DAY_COUNT=$((DAY_COUNT + 1))

    if [ -n "$END_DATE" ]; then
        # With an end date, continue without prompting.
        if [ "$CURRENT_DATE" = "$END_DATE" ]; then
            break
        fi
        echo ""
        echo "  (Waiting 2 seconds for Photos.app before continuing...)"
        sleep 2
        CURRENT_DATE=$(next_date "$CURRENT_DATE")
        continue
    fi

    # Without an end date, stop after today.
    NEXT_DATE=$(next_date "$CURRENT_DATE")
    TODAY=$(date +%F)
    if [[ "$NEXT_DATE" > "$TODAY" ]]; then
        echo ""
        echo "  Reached today ($TODAY); finishing automatically"
        break
    fi

    # Ask whether to continue; Enter or a 20-second timeout continues, n/N/Esc stops.
    echo ""
    echo "  (Waiting 2 seconds for Photos.app...)"
    sleep 2
    echo -n "  Export $NEXT_DATE too? (Enter=continue, n=stop; auto-continue after 20 seconds): "
    read -t 20 -n1 -r CONTINUE
    echo ""
    if [[ "$CONTINUE" == $'\e' ]] || [[ "$CONTINUE" =~ ^[nN] ]]; then
        break
    fi
    # Continue after a timeout, Enter, or any other key.
    CURRENT_DATE="$NEXT_DATE"
done

echo ""
echo "  Export complete: $DAY_COUNT days, $TOTAL_EXPORTED photos"
echo ""

# ── 3. Rename the folder for a multi-day export without an end date ──
if [ -z "$END_DATE" ] && [ "$LAST_DATE" != "$START_DATE" ]; then
    NEW_DIR="$(pwd)/${START_DATE}_${LAST_DATE}"
    if [ -d "$NEW_DIR" ]; then
        echo "  ⚠️ Destination directory exists; keeping the original name"
    else
        mv "$OUTPUT_DIR" "$NEW_DIR"
        OUTPUT_DIR="$NEW_DIR"
        PHOTO_DIR="$OUTPUT_DIR/photos"
        echo "  Renamed directory: $OUTPUT_DIR"
    fi
fi

# ── 4. Check export results ──
FILE_COUNT=$(ls "$PHOTO_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
    echo "❌ No photos were exported."
    echo "   Possible causes: permission denied or no photos in the selected date range"
    echo ""
    echo "Press Enter to exit..."
    read
    exit 1
fi

echo "  Files on disk: $FILE_COUNT"
echo ""

# ── 5. Generate thumbnails, photos.json, and index.html ──
echo "[2/3] Generating thumbnails and map data..."
echo "      Reading EXIF GPS data and generating 200px thumbnails..."
echo ""

"$PYTHON" "$WORK_DIR/gen_photo_map.py" "$PHOTO_DIR" \
    --output "$OUTPUT_DIR" \
    --thumb-size 200 \
    2>&1

echo ""

# ── 6. Start the preview ──
echo "[3/3] Starting preview server..."
echo ""

lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null || true

"$PYTHON" -m http.server 8765 --directory "$OUTPUT_DIR" &
SERVER_PID=$!
sleep 2

echo "╔══════════════════════════════════════════╗"
echo "║  ✅ All done!                             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Photos: $FILE_COUNT"
echo "  Days:   $DAY_COUNT"
echo "  Output directory: $OUTPUT_DIR"
echo ""
echo "  Directory structure:"
echo "    $OUTPUT_DIR/"
echo "    ├── photos/        Original photos"
echo "    ├── thumbnails/    Thumbnails"
echo "    ├── photos.json    Date and coordinate metadata"
echo "    └── index.html     Map page"
echo ""
echo "  Preview URL: http://localhost:8765/"
echo ""
echo "  Opening browser..."
echo ""

open "http://localhost:8765/"

echo "Press Enter to stop the server and exit..."
read
kill $SERVER_PID 2>/dev/null
echo "Exited."
