# Photo Way user guide

[简体中文](USER_GUIDE.zh-CN.md) · [Project README](../README.md)

## Install

Download a Windows setup executable or MSI, or the macOS universal DMG, from the project release. Open the installer and follow its prompts. The v0.1.0 installers are unsigned: Windows SmartScreen may ask you to select **More info → Run anyway**; on macOS, control-click the app and choose **Open** for the first launch. The macOS full flow has not yet been manually verified.

## Make a map

1. Drop a folder or media files onto the app. Supported types include JPEG, HEIC/HEIF, PNG, TIFF, DNG, MOV, and MP4.
2. Review the import summary. Items without usable location data or that cannot be read are skipped.
3. Choose media and privacy options. **Thumbnails only** makes a smaller export; web-size and original media need more space. Strip EXIF and coordinate rounding reduce information shared with recipients.
4. Check the live preview, then export an HTML file, folder, or ZIP. For a folder or ZIP, keep all included files together. Extract a ZIP before opening `index.html` directly from disk.
5. Share the export. Recipients need a modern browser; they do not need Photo Way. The offline world map works without a connection. Satellite, street, topographic, and 3D terrain maps require network access.

In the exported viewer, use the timeline and filters to explore the trip. Drag a pin to correct a location, hide an item, or use **Save a copy** to include edits in a new export. User-entered titles and filenames are retained as entered.

## Languages in v0.2.0

The bilingual controls described here are being implemented and are not available in v0.1.0. The planned desktop **Language / 语言** setting offers **System**, **English**, and **简体中文**. A separate export-language choice sets the initial language of a new export. Its recipient can switch between English and Simplified Chinese in the viewer; the choice is saved for that trip when browser storage is available. Switching languages does not translate photo titles or filenames. Existing v0.1.0 exports keep their original embedded viewer; create a new export to gain bilingual controls. Operating system file picker labels and third-party map labels may follow their own language settings.

Installer language only controls installer text. It does not set the app's saved language preference. Both Windows MSI variants contain the same bilingual app; the NSIS setup includes a language selector.
