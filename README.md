<p align="center"><img src="logo.svg" width="112" alt="Omni Downloader logo: a download arrow inside a halftone ring of dots"></p>

# Omni Downloader

A Tampermonkey script that finds the images, videos and audio on any page, including HLS (`.m3u8`) streams that players load behind a `blob:` address, and saves them.

Press **Alt+Shift+D**, or the button at the bottom right (its badge counts the videos and audio found; it can be hidden from Tampermonkey's menu). The panel opens with the filter box focused, and **Esc** closes it. Alt+D is the browser's own "go to the address bar", so it's left alone unless you switch to it from Tampermonkey's menu.

Point at a video or an audio player on the page and a **Download this media** button appears just under it (or inside its top edge when there's no room below). It opens the panel on that media's row, focused and ready for Save or Ghost. It can be turned off from Tampermonkey's menu.

Each file or stream has one main button, **Save** or **Ghost**, and a **▾** beside it with the rest: save in the browser, send to Ghost Downloader, copy the address, copy an ffmpeg command, and for HLS *keep as .ts*. Whichever of Save and Ghost you pick from the ▾ becomes the main button from then on.

It works from the keyboard: ↓ from the filter goes into the list, ↑ and ↓ move between rows, ← and → between tabs and between images, Space selects an image and Enter saves it. Saves, Ghost sends, copies and errors are announced to screen readers.

## What it does

- **Video** (each with a thumbnail you can click to play, and its size: a file's real size, read from the server without downloading it and counting its sound file when the two are saved together; a stream's estimate per quality, from its bitrate and length)
  - HLS streams come with a quality picker. **Save** fetches the parts 6 at a time (3 tries each) and joins them into one **MP4**; choose *keep as .ts* in its ▾ menu to skip converting. A stream that is DRM-protected says so on its row, before you press anything, and one large enough to strain memory suggests Ghost instead.
  - Streams encrypted with plain AES-128 are decrypted with the playlist's own key, as the player does.
  - Direct video files save as they are. Sites that load one file in byte-range pieces (Instagram, Facebook) show it as one row, and Save gets the whole file.
  - Where the picture and the sound are separate files (Instagram, Facebook, Bilibili and other DASH players), **Save** on the picture finds its sound file (the same Instagram asset id or Bilibili video id, else the same length) and joins the two into one MP4, without re-encoding. If the sound hasn't loaded yet, play the video for a moment and save again. The sound file itself is listed under **Audio** as a sound track, and saves on its own as `.m4a`.
- **Images**: a grid of every image, including the largest `srcset` entry, `<picture>` sources, CSS backgrounds, posters and `og:image`. Hide the small ones by size, pick some, then save them as a **ZIP**, one by one, or send them to Ghost (from the ▾; your choice is remembered). Double-click an image, or press Enter on it, to save just that one.
- **Audio**: audio files, the sound tracks of sites that keep sound apart from the picture, and the separate sound tracks some HLS streams have.
- Every save shows its progress under the row (parts done for a stream, MB of the total for a file, picture then sound when the two are joined), with **Stop**, and ends by naming the file it saved, or saying what went wrong and what to try.
- **Copy address** and **Copy ffmpeg command** in every row's ▾, for anything better done outside the browser.
- **Ghost**: a **Ghost** button on every file and stream (and for picked images) hands it to [Ghost Downloader 3](https://github.com/XiaoYouChR/Ghost-Downloader-3), which downloads it outside the browser in parallel pieces and can resume. It sends the page's Referer and User-Agent and its cookies for that address, the chosen quality of a stream, and the file name. DASH streams can go there too. **Page to Ghost** at the bottom sends the page itself, for sites Ghost reads on its own (YouTube, Bilibili). Turn on *aria2 RPC* in Ghost's settings; its port (16800) and token are set from Tampermonkey's menu. Also turn on *Emulate browser fingerprint* in the same settings: sites behind Cloudflare refuse a plain download client (Ghost then says the link couldn't be parsed). Some of them also want the browser's Cloudflare cookie: in Tampermonkey → Settings (Advanced) → Security, set *Allow scripts to access cookies* to **All**, so Omni can pass it on.
- **YouTube**: on a video, a Short or an embedded YouTube player, the Video tab lists that video with its thumbnail and title. YouTube locks its streams, so it can't be saved in the browser: its **Ghost** button sends the video's address to Ghost Downloader, which saves it with yt-dlp.
- **Frames**: embedded players inside frames report what they find to the page, and their files are fetched with the frame's address as Referer.

## What it doesn't do

- **DRM-protected streams** (SAMPLE-AES, Widevine, FairPlay, PlayReady) are refused.
- **DASH (`.mpd`)** is listed with its ffmpeg command but not saved here.
- **Live streams** save only the parts listed when you press Save.
- **YouTube** (and Shorts) streams through its own locked format, not files the page loads; the script doesn't try to get around that. It lists the video for Ghost Downloader (yt-dlp) instead, for videos you may save.

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
- The panel's fonts (Inter and JetBrains Mono) are bundled with `@resource`, downloaded once when the script is installed, so pages make no font requests.
- MPEG-TS is turned into MP4 by [mux.js](https://github.com/videojs/mux.js), and ZIPs are made by [fflate](https://github.com/101arrowz/fflate). Both are loaded with `@require`.
- Nothing is sent anywhere except the requests for the files themselves, and, when you press Ghost, the file's address and headers to Ghost Downloader on your own computer (127.0.0.1).
