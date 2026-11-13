# Omni Downloader

A Tampermonkey script that finds the images, videos and audio on any page, including HLS (`.m3u8`) streams that players load behind a `blob:` address, and saves them.

Press **Alt+D**, or the ⬇ button at the bottom right (its badge counts the videos and audio found; it can be hidden from Tampermonkey's menu). The panel has a filter box on top, and **Esc** closes it.

## What it does

- **Video** (each with a thumbnail you can click to play, and its size: a file's real size, read from the server without downloading it and counting its sound file when the two are saved together; a stream's estimate per quality, from its bitrate and length)
  - HLS streams come with a quality picker. **Save video** fetches the parts 6 at a time (3 tries each) and joins them into one **MP4**; tick *keep .ts* to skip converting.
  - Streams encrypted with plain AES-128 are decrypted with the playlist's own key, as the player does.
  - Direct video files save as they are. Sites that load one file in byte-range pieces (Instagram, Facebook) show it as one row, and Save gets the whole file.
  - Where the picture and the sound are separate files (Instagram, Facebook, Bilibili and other DASH players), **Save** on the picture finds its sound file (the same Instagram asset id or Bilibili video id, else the same length) and joins the two into one MP4, without re-encoding. If the sound hasn't loaded yet, play the video for a moment and save again. The sound file itself is listed under **Audio** as a sound track, and saves on its own as `.m4a`.
- **Images**: a grid of every image, including the largest `srcset` entry, `<picture>` sources, CSS backgrounds, posters and `og:image`. Hide the small ones by size, pick some, then save them as a **ZIP** or one by one. Double-click an image to save just that one.
- **Audio**: audio files, the sound tracks of sites that keep sound apart from the picture, and the separate sound tracks some HLS streams have.
- Every save shows its progress under the row (parts done for a stream, MB of the total for a file, picture then sound when the two are joined), with **Stop**.
- **Copy URL** and **Copy ffmpeg** on every stream and file, for anything better done outside the browser.
- **Frames**: embedded players inside frames report what they find to the page, and their files are fetched with the frame's address as Referer.

## What it doesn't do

- **DRM-protected streams** (SAMPLE-AES, Widevine, FairPlay, PlayReady) are refused.
- **DASH (`.mpd`)** is listed with its ffmpeg command but not saved here.
- **Live streams** save only the parts listed when you press Save.
- **YouTube** (and Shorts) streams through its own locked format, not files the page loads; the script doesn't try to get around that. Use YouTube's own Download, or yt-dlp for videos you may save.

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
