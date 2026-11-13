# Omni Downloader

A Tampermonkey script that finds the images, videos and audio on any page, including HLS (`.m3u8`) streams that players load behind a `blob:` address, and saves them.

Press **Alt+D**, or the small ⬇ button at the bottom right (it can be hidden from Tampermonkey's menu).

## What it does

- **Video**
  - HLS streams come with a quality picker. **Save video** fetches the parts 6 at a time (3 tries each) and joins them into one **MP4**; tick *keep .ts* to skip converting.
  - Streams encrypted with plain AES-128 are decrypted with the playlist's own key, as the player does.
  - Direct video files save as they are.
- **Images**: a grid of every image, including the largest `srcset` entry, `<picture>` sources, CSS backgrounds, posters and `og:image`. Hide the small ones by size, pick some, then save them as a **ZIP** or one by one. Double-click an image to save just that one.
- **Audio**: audio files, and the separate sound tracks some HLS streams have.
- **Copy URL** and **Copy ffmpeg** on every stream and file, for anything better done outside the browser.
- **Frames**: embedded players inside frames report what they find to the page, and their files are fetched with the frame's address as Referer.

## What it doesn't do

- **DRM-protected streams** (SAMPLE-AES, Widevine, FairPlay, PlayReady) are refused.
- **DASH (`.mpd`)** is listed with its ffmpeg command but not saved here.
- **Live streams** save only the parts listed when you press Save.

The whole video is put together in memory before saving, so very long high-quality streams need a lot of RAM.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [the raw script](https://raw.githubusercontent.com/Adztrz/omni-downloader/master/omni-downloader.user.js): Tampermonkey offers to install it, and keeps it up to date from here.

Or by hand: Tampermonkey → Dashboard → **+**, replace everything with [`omni-downloader.user.js`](omni-downloader.user.js), Ctrl+S.

To save video and audio files directly, Tampermonkey may need them allowed in Settings → Downloads (*Whitelisted file extensions*). If it refuses, the script fetches the file and saves it itself.

## How it works

- It runs at `document-start` on every page.
  - It reads the browser's list of network requests (resource timing) for media addresses.
  - It watches the page's `fetch`/XHR answers for playlists whose address doesn't end in `.m3u8`.
  - It reads the page itself for images and media elements.
- Files are fetched through `GM_xmlhttpRequest`, so other sites' files work.
- MPEG-TS is turned into MP4 by [mux.js](https://github.com/videojs/mux.js), and ZIPs are made by [fflate](https://github.com/101arrowz/fflate). Both are loaded with `@require`.
- Nothing is sent anywhere except the requests for the files themselves.
