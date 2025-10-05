# Pixiv Bulk Downloader

This cross-browser WebExtension adds a toolbar button and on-canvas shortcut that download every image from the current Pixiv artwork page in one click. It works with single illustrations, manga posts with multiple pages, and animated _ugoira_ ZIPs.

## About the Project

Pixiv Bulk Downloader is a powerful yet simple tool designed for collectors, and enthusiasts who want to save Pixiv artworks efficiently. Born from the frustration of downloading multiple images one by one, this extension automates the process while respecting Pixiv's terms of service and providing robust fallback mechanisms for reliable downloads.

### Key Highlights
- **Seamless Integration**: Works directly in your browser without requiring external software.
- **Smart Metadata Parsing**: Extracts image URLs from Pixiv's preload data or falls back to Ajax APIs for maximum compatibility.
- **User-Friendly Interface**: Localized in English, Japanese, and Simplified Chinese, with customizable options for download behavior.
- **Reliability First**: Handles network errors, retries failed URLs, and ensures filenames are safe and descriptive.
- **Privacy-Focused**: No data collection; everything stays local to your browser.

Whether you're archiving your favorite artist's work or building a personal collection, Pixiv Bulk Downloader makes it effortless and fast.

## Features

- Parses Pixiv’s embedded metadata (with Ajax fallback) to collect the original-resolution image URLs.
- Handles both single and multi-page illustrations, plus ugoira ZIP assets.
- Creates a tidy folder structure: `Pixiv/<artist>/<illustId>-<title>/...`.
- Floating download button appears on the artwork preview and opens a range selector (defaults to all pages).
- Visual badge feedback during the download process.
- Localized interface: English (default), Japanese, and Simplified Chinese.
- Options page to tweak defaults (range behaviour, overlay toggle, filenames) and explore the creator’s other projects.
- Works in Chromium-based browsers (Chrome, Edge, Brave, Vivaldi) and Firefox.
- And last, fast and understandable settings (you can open it via right-clicking to extention's logo) menu.

## Installation

### Chromium browsers (Chrome, Edge, Brave, Vivaldi)

1. Open the browser’s extensions page:
   - Chrome: navigate to `chrome://extensions/`.
   - Edge: navigate to `edge://extensions/`.
   - Brave/Vivaldi or something based Chromium: similar path via browser settings.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and choose the `pixivinstall` folder.
4. Pin the “Pixiv Bulk Downloader” icon from the toolbar for quick access.

### Firefox

1. Enter `about:debugging#/runtime/this-firefox` in the address bar.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file inside the `pixivinstall` folder.
4. Optional: pin the extension icon from the toolbar menu.

#### Uploading to Firefox Add-ons (AMO)

Firefox currently requires Manifest V2 packages for public listings. A ready-to-use MV2 manifest is included as `manifest.firefox.json`.

1. Duplicate or export the project to a separate folder dedicated to the Firefox build.
2. Replace the root `manifest.json` with a copy of `manifest.firefox.json` (rename the file to `manifest.json`).
3. Review the permissions – MV2 uses `browser_action` and drops the Manifest V3-specific `declarativeNetRequest` entry.
4. Zip the folder contents and upload the archive to [Firefox Add-ons Developer Hub](https://addons.mozilla.org/developers/).

The regular Chromium build continues to use the default MV3 `manifest.json`.


## Usage

1. Open any Pixiv artwork detail page, e.g. `https://www.pixiv.net/en/artworks/12345678`.
2. Hover the illustration—an extension button appears in the top-right corner of the artwork.
3. Click the button to keep the default “all pages” selection or pick a custom page range, then confirm.
4. Watch the toolbar badge for progress (e.g. `1/4`, `✔`, or `ERR`).
5. The browser’s downloads panel will show each image as it saves.

## Settings & customization

- Open the extension’s **Options** page (Chrome/Edge: right-click the toolbar icon → *Options*; Firefox: `about:addons` → Pixiv Bulk Downloader → *Preferences*).
- Choose how downloads behave:
   - Interface language override (English, Japanese, or Simplified Chinese).
   - Default page range: download everything, ask every time, or reuse your last custom range (hold **Shift** while clicking the overlay button to force the dialog).
   - Toggle the on-canvas overlay button if you prefer the toolbar icon only.
   - Decide whether filenames include the `_pixiv-only` anti-theft suffix.
   - Rename the root download folder and retry failed URLs automatically.
- Preferences are stored via `chrome.storage.sync` when available so they follow you across browsers signed into the same account (with a local fallback otherwise).

## Notes & limitations

- You must already be logged in to Pixiv in the browser for restricted posts.
- For animated ugoira posts, the original ZIP is downloaded; extracting frames requires external tools.
- The extension doesn’t yet process Pixiv novels or other non-illustration URLs.
- Large batches rely on the browser download manager/pausing or resuming happens there.
- Range selection is 1-indexed and inclusive; leaving the defaults will download everything.
- If the Pixiv page doesn’t expose preload metadata, the extension automatically falls back to the official Ajax endpoints.

- The extension defaults to English; override in settings to switch to Japanese or Simplified Chinese.
