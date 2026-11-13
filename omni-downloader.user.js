// ==UserScript==
// @name         Omni Downloader
// @namespace    https://github.com/Adztrz
// @version      1.1
// @description  Finds the images, videos and audio on any page, including HLS (m3u8) streams the player loads, and saves them: one file, a ZIP of many, or a whole HLS video joined into one MP4. Alt+D opens it.
// @author       Adztrz
// @homepageURL  https://github.com/Adztrz/omni-downloader
// @updateURL    https://raw.githubusercontent.com/Adztrz/omni-downloader/master/omni-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/Adztrz/omni-downloader/master/omni-downloader.user.js
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// ==/UserScript==

(function () {
  "use strict";

  // What it finds:
  // - on the page: <img> (the largest srcset entry), <picture> sources, CSS background images, <video>/<audio> and their
  //   <source>s, posters, links to media files, and og:image / og:video;
  // - on the network: every request the page makes, watched through the browser's resource timing list, plus the page's
  //   fetch / XHR answers that start with #EXTM3U (playlists with no .m3u8 in their address). Players that play a
  //   blob: URL load their stream this way, so the stream itself shows up here.
  // Frames (most embedded players) report what they find to the top page, which shows one list and does the downloads,
  // sending the frame's address as Referer so hosts that check it still answer.
  // HLS: a master playlist offers its qualities; the chosen one's segments are fetched 6 at a time (3 tries each),
  // AES-128 segments are decrypted with the playlist's key as a player would, and the parts are joined: fMP4 as .mp4,
  // MPEG-TS turned into .mp4 by mux.js (or kept as .ts if that fails). DRM-protected streams (SAMPLE-AES, Widevine,
  // FairPlay, PlayReady) are refused: they can't be saved, and the script doesn't try.

  const TOP = window.top === window.self;
  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const MSG = "omni-downloader:found";
  const store = {
    get: (k, d) => { try { return typeof GM_getValue === "function" ? GM_getValue(k, d) : JSON.parse(localStorage.getItem("omni." + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { typeof GM_setValue === "function" ? GM_setValue(k, v) : localStorage.setItem("omni." + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- what counts as media ----------
  const EXT = {
    image: /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|jfif|heic)(?:$|[?#])/i,
    video: /\.(mp4|webm|mkv|mov|m4v|ogv|flv|avi)(?:$|[?#])/i,
    audio: /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:$|[?#])/i,
    hls: /\.m3u8(?:$|[?#])/i,
    dash: /\.mpd(?:$|[?#])/i,
  };
  const SEGMENT = /\.(ts|m4s|aac|vtt|webvtt|key)(?:$|[?#])|\/seg[-_]?\d|[?&](?:range|bytes)=/i; // pieces of a stream, not files
  const kindOf = (url) => EXT.hls.test(url) ? "hls" : EXT.dash.test(url) ? "dash" : EXT.video.test(url) ? "video" : EXT.audio.test(url) ? "audio" : EXT.image.test(url) ? "image" : null;
  const abs = (u, base = location.href) => { try { const x = new URL(u, base); return /^(https?|blob|data):$/.test(x.protocol) ? x.href : null; } catch { return null; } };

  // ---------- the list (each frame keeps its own; frames send theirs to the top) ----------
  const found = new Map(); // url → { url, kind, w, h, from, referer, title }
  const partOf = new Set(); // quality playlists of a master already listed: shown as its qualities, not as rows
  let onChange = () => {};
  // players that fetch a file in byte ranges (Instagram, Facebook…) put the range in the address: drop it, so the pieces are
  // one file and Save gets all of it ("#t=…" after an address is a start time, not another file, so it goes too)
  const whole = (u) => { try { const x = new URL(u); let cut = !!x.hash && !/^data:/.test(u); x.hash = ""; for (const k of ["bytestart", "byteend", "range"]) if (x.searchParams.has(k)) { x.searchParams.delete(k); cut = true; } return cut ? x.href : u; } catch { return u; } };
  function add(url, kind, extra = {}) {
    url = abs(url); if (!url) return; url = whole(url);
    kind = kind || kindOf(url); if (!kind) return;
    if (kind !== "hls" && kind !== "dash" && SEGMENT.test(url)) return;
    if (/^data:/.test(url) && url.length < 3000) return; // tiny inline icons
    const old = found.get(url), item = { url, kind, referer: location.href, title: document.title, ...old, ...extra };
    if (old && old.kind !== "image" && kind === "image") item.kind = old.kind; // a poster stays a poster only if nothing better
    if (!old || extra.w > (old.w || 0) || kind !== old.kind) { found.set(url, item); changed(item); }
  }
  let sendTimer = 0;
  function changed(item) {
    if (TOP) return void onChange();
    clearTimeout(sendTimer); sendTimer = setTimeout(() => { try { window.top.postMessage({ [MSG]: [...found.values()] }, "*"); } catch {} }, 300);
  }
  if (TOP) window.addEventListener("message", (e) => {
    const list = e.data && e.data[MSG]; if (!Array.isArray(list)) return;
    for (const it of list.slice(0, 2000)) if (it && typeof it.url === "string" && /^https?:/.test(it.url)) {
      const old = found.get(it.url); if (!old) found.set(it.url, { ...it, frame: true });
    }
    onChange();
  });

  // ---------- watching the network ----------
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) add(e.name); }).observe({ type: "resource", buffered: true });
  } catch {}
  // playlists whose address doesn't say m3u8: look at the answers' first bytes
  try {
    const XO = W.XMLHttpRequest && W.XMLHttpRequest.prototype, open = XO && XO.open;
    if (open) XO.open = function (m, u) {
      try { this.addEventListener("load", function () { try { if ((this.responseType === "" || this.responseType === "text") && typeof this.responseText === "string" && this.responseText.startsWith("#EXTM3U")) add(this.responseURL || u, "hls"); } catch {} }); } catch {}
      return open.apply(this, arguments);
    };
    const f = W.fetch;
    if (f) W.fetch = function (input, init) {
      const p = f.apply(this, arguments);
      p.then((res) => {
        try {
          const ct = res.headers.get("content-type") || "";
          if (/mpegurl/i.test(ct)) add(res.url, "hls");
          else if (/dash\+xml/i.test(ct)) add(res.url, "dash");
        } catch {}
      }, () => {});
      return p;
    };
  } catch {}

  // ---------- reading the page ----------
  function bestSrcset(ss, base) {
    let best = null, bw = -1;
    for (const part of String(ss || "").split(/,\s+(?=\S)/)) {
      const [u, d] = part.trim().split(/\s+/); const w = d ? parseFloat(d) * (/x$/.test(d) ? 1000 : 1) : 1;
      if (u && w > bw) { bw = w; best = abs(u, base); }
    }
    return best;
  }
  function scan() {
    const d = document;
    for (const img of d.images) {
      const u = bestSrcset(img.srcset) || img.currentSrc || img.src;
      if (u) add(u, "image", { w: img.naturalWidth, h: img.naturalHeight });
    }
    for (const s of d.querySelectorAll("picture source[srcset]")) { const u = bestSrcset(s.srcset); if (u) add(u, "image"); }
    for (const m of d.querySelectorAll("video, audio")) {
      const kind = m.tagName === "VIDEO" ? "video" : "audio";
      for (const u of [m.currentSrc, m.src, ...[...m.querySelectorAll("source")].map((s) => s.src)]) {
        if (!u || /^blob:/.test(u)) continue; // a blob: is a player feeding a stream; the stream is in the network list
        add(u, kindOf(u) === "hls" ? "hls" : kindOf(u) === "dash" ? "dash" : kind, { w: m.videoWidth || 0, h: m.videoHeight || 0 });
      }
      if (m.poster) add(m.poster, "image", { poster: true });
    }
    for (const a of d.querySelectorAll("a[href]")) { const k = kindOf(a.href); if (k) add(a.href, k); }
    for (const m of d.querySelectorAll('meta[property^="og:image"], meta[property^="og:video"], meta[name="twitter:image"]')) {
      const c = m.content; if (c && !/:(width|height|type|alt)$/.test(m.getAttribute("property") || "")) add(c, /video/.test(m.getAttribute("property") || "") ? null : "image");
    }
    // CSS backgrounds (capped so a huge page doesn't stall)
    let n = 0;
    for (const el of d.querySelectorAll("body *")) {
      if (++n > 4000) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none") for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(m[1], "image", { bg: true });
    }
  }
  // frames scan themselves once loaded and when the page changes, and send the result up
  if (!TOP) {
    const go = () => { try { scan(); } catch {} };
    if (document.readyState === "complete") setTimeout(go, 500); else window.addEventListener("load", () => setTimeout(go, 500));
    setInterval(() => { if (document.querySelector("video, audio")) go(); }, 5000);
    return; // frames have no panel of their own
  }

  // ---------- fetching (cross-origin through Tampermonkey, with the page that loaded it as Referer) ----------
  function get(url, type, referer, signal) {
    if (typeof GM_xmlhttpRequest !== "function" || /^(blob|data):/.test(url))
      return fetch(url, { signal, credentials: new URL(url, location.href).origin === location.origin ? "include" : "omit" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return type === "text" ? r.text() : r.arrayBuffer(); });
    return new Promise((resolve, reject) => {
      const req = GM_xmlhttpRequest({
        method: "GET", url, responseType: type === "text" ? "text" : "arraybuffer", anonymous: false,
        headers: referer ? { Referer: referer } : {},
        onload: (r) => r.status >= 200 && r.status < 300 ? resolve(type === "text" ? r.responseText : r.response) : reject(new Error(`HTTP ${r.status}`)),
        onerror: () => reject(new Error("network error")), ontimeout: () => reject(new Error("timed out")), timeout: 60000,
      });
      signal?.addEventListener("abort", () => { try { req.abort(); } catch {} reject(new DOMException("Stopped", "AbortError")); });
    });
  }
  async function getRetry(url, type, referer, signal, tries = 3) {
    for (let i = 1; ; i++) {
      try { return await get(url, type, referer, signal); }
      catch (e) { if (signal?.aborted || i >= tries) throw e; await new Promise((r) => setTimeout(r, 600 * i)); }
    }
  }
  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = u; a.download = name; a.style.display = "none"; document.documentElement.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "download";
  function fileName(it, fallbackExt) {
    if (/^data:/.test(it.url)) return `${clean(document.title)}.${(/^data:\w+\/([\w+]+)/.exec(it.url)?.[1] || fallbackExt).replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
    let last = ""; try { last = decodeURIComponent(new URL(it.url).pathname.split("/").filter(Boolean).pop() || ""); } catch {}
    if (!/\.\w{2,5}$/.test(last)) last = `${last || clean(it.title || document.title)}.${fallbackExt}`;
    return clean(last);
  }
  // one direct file: Tampermonkey's own download (cross-origin, keeps the name), else fetch and save
  async function saveDirect(it) {
    if (it.hlsAudio || EXT.hls.test(it.url)) return saveHlsAudio(it);
    const name = fileName(it, it.kind === "image" ? "jpg" : it.kind === "audio" ? "mp3" : "mp4");
    if (typeof GM_download === "function" && /^https?:/.test(it.url)) {
      try {
        await new Promise((resolve, reject) => GM_download({ url: it.url, name, headers: { Referer: it.referer || location.href }, onload: resolve, onerror: (e) => reject(new Error(e?.error || "download failed")), ontimeout: () => reject(new Error("timed out")) }));
        return;
      } catch (e) { if (!/not_whitelisted|not_enabled|not_permitted/i.test(String(e.message))) throw e; } // file type not allowed in Tampermonkey's settings: save it ourselves
    }
    saveBlob(new Blob([await getRetry(it.url, "buffer", it.referer)]), name);
  }

  // ---------- HLS ----------
  const attrs = (s) => { const o = {}; for (const m of String(s).matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) o[m[1]] = m[3] ?? m[2]; return o; };
  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()), variants = [], audio = [];
    lines.forEach((l, i) => {
      if (l.startsWith("#EXT-X-STREAM-INF:")) {
        const a = attrs(l.slice(18)); let u = ""; for (let j = i + 1; j < lines.length && !u; j++) if (lines[j] && !lines[j].startsWith("#")) u = lines[j];
        if (u) variants.push({ url: abs(u, base), bw: +a.BANDWIDTH || 0, res: a.RESOLUTION || "", audio: a.AUDIO || "", codecs: a.CODECS || "" });
      } else if (l.startsWith("#EXT-X-MEDIA:")) {
        const a = attrs(l.slice(13)); if (a.TYPE === "AUDIO" && a.URI) audio.push({ url: abs(a.URI, base), group: a["GROUP-ID"], name: a.NAME || a.LANGUAGE || "audio", def: a.DEFAULT === "YES" });
      }
    });
    variants.sort((x, y) => (parseInt(y.res.split("x")[1]) || 0) - (parseInt(x.res.split("x")[1]) || 0) || y.bw - x.bw);
    return { variants, audio };
  }
  function parseMedia(text, base) {
    const segs = []; let key = null, map = null, seq = 0, dur = 0, range = null, lastEnd = 0, drm = "";
    const byterange = (v) => { const [len, off] = String(v).split("@").map(Number); const start = Number.isFinite(off) ? off : lastEnd; lastEnd = start + len; return [start, start + len - 1]; };
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim(); if (!l) continue;
      if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = +l.split(":")[1] || 0;
      else if (l.startsWith("#EXT-X-KEY:")) {
        const a = attrs(l.slice(11));
        if (a.METHOD === "NONE") key = null;
        else if (a.METHOD === "AES-128" && (!a.KEYFORMAT || a.KEYFORMAT === "identity")) key = { uri: abs(a.URI, base), iv: a.IV || null };
        else drm = a.KEYFORMAT || a.METHOD;
      } else if (l.startsWith("#EXT-X-MAP:")) { const a = attrs(l.slice(11)); map = { url: abs(a.URI, base), range: a.BYTERANGE ? byterange(a.BYTERANGE) : null }; lastEnd = 0; }
      else if (l.startsWith("#EXTINF:")) dur += parseFloat(l.slice(8)) || 0;
      else if (l.startsWith("#EXT-X-BYTERANGE:")) range = byterange(l.slice(17));
      else if (!l.startsWith("#")) { segs.push({ url: abs(l, base), key, seqNo: seq + segs.length, range }); range = null; }
    }
    return { segs, map, dur, live: !/#EXT-X-ENDLIST/.test(text), drm };
  }
  const keyCache = new Map();
  async function decrypt(buf, seg, referer, signal) {
    if (!seg.key) return buf;
    let k = keyCache.get(seg.key.uri);
    if (!k) { k = getRetry(seg.key.uri, "buffer", referer, signal).then((raw) => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])); keyCache.set(seg.key.uri, k); }
    const iv = new Uint8Array(16);
    if (seg.key.iv) { const hex = seg.key.iv.replace(/^0x/i, "").padStart(32, "0"); for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
    else new DataView(iv.buffer).setUint32(12, seg.seqNo); // no IV given: the segment's media sequence number
    return crypto.subtle.decrypt({ name: "AES-CBC", iv }, await k, buf);
  }
  async function getPart(p, referer, signal) {
    if (!p.range || typeof GM_xmlhttpRequest !== "function") return getRetry(p.url, "buffer", referer, signal).then((b) => p.range ? b.slice(p.range[0], p.range[1] + 1) : b);
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: "GET", url: p.url, responseType: "arraybuffer", headers: { Range: `bytes=${p.range[0]}-${p.range[1]}`, ...(referer ? { Referer: referer } : {}) },
      onload: (r) => r.status < 300 ? resolve(r.status === 206 ? r.response : r.response.slice(p.range[0], p.range[1] + 1)) : reject(new Error(`HTTP ${r.status}`)), onerror: () => reject(new Error("network error")) }));
  }
  // every segment, 6 at a time, in order; progress(done, total)
  async function getSegments(list, referer, signal, progress) {
    const out = new Array(list.segs.length); let next = 0, done = 0;
    const worker = async () => {
      while (next < list.segs.length) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        const i = next++, s = list.segs[i];
        out[i] = await decrypt(await getPart(s, referer, signal), s, referer, signal);
        progress(++done, list.segs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, list.segs.length) }, worker));
    return out;
  }
  // MPEG-TS pieces → one MP4 (mux.js); null when that isn't possible
  function tsToMp4(parts) {
    const mux = W.muxjs || window.muxjs || (typeof muxjs !== "undefined" ? muxjs : null);
    if (!mux?.mp4?.Transmuxer) return null;
    try {
      const t = new mux.mp4.Transmuxer({ remux: true }), body = []; let init = null;
      t.on("data", (s) => { if (!init) init = s.initSegment; body.push(s.data); });
      for (const p of parts) t.push(new Uint8Array(p));
      t.flush();
      return init && body.length ? new Blob([init, ...body], { type: "video/mp4" }) : null;
    } catch { return null; }
  }
  async function saveHls(it, choice, ui) {
    const ref = it.referer || location.href, signal = ui.signal;
    const media = parseMedia(await getRetry(choice.url, "text", ref, signal), choice.url);
    if (media.drm) throw new Error(`This stream is DRM-protected (${media.drm}): it can't be saved.`);
    if (!media.segs.length) throw new Error("The playlist has no segments.");
    const parts = await getSegments(media, ref, signal, (d, n) => ui.progress(d / n, `${d} / ${n} parts`));
    if (media.map) parts.unshift(await getPart(media.map, ref, signal));
    const base = clean(it.title || document.title) + (choice.res ? ` ${choice.res.split("x")[1]}p` : "");
    if (media.map) return saveBlob(new Blob(parts, { type: "video/mp4" }), `${base}.mp4`); // fMP4: already MP4 pieces
    ui.progress(1, "Joining into MP4…"); await new Promise((r) => setTimeout(r, 30));
    const mp4 = choice.asTs ? null : tsToMp4(parts);
    if (mp4) saveBlob(mp4, `${base}.mp4`); else saveBlob(new Blob(parts, { type: "video/mp2t" }), `${base}.ts`);
    return media;
  }

  // an HLS audio track (found through a master playlist): its parts joined into one file
  async function saveHlsAudio(it) {
    const ctl = new AbortController(), media = parseMedia(await getRetry(it.url, "text", it.referer), it.url);
    if (media.drm) throw new Error("DRM-protected");
    const parts = await getSegments(media, it.referer, ctl.signal, () => {});
    if (media.map) parts.unshift(await getPart(media.map, it.referer, ctl.signal));
    saveBlob(new Blob(parts), `${clean(it.title)}.${media.map ? "m4a" : "aac"}`);
  }

  // ---------- the panel ----------
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px;
      border: 0; border-radius: 8px; background: #090b0c; color: #efefed; font: 500 13px/1 Inter, ui-sans-serif, system-ui, sans-serif; cursor: pointer;
      box-shadow: inset 0 0 0 1px #363738, 0 12px 10px rgba(0,0,0,.25), 0 2px 2px rgba(0,0,0,.2); opacity: .85; }
    .fab:hover { opacity: 1; } .fab b { font-weight: 500; color: #8a8b8a; font-variant-numeric: tabular-nums; }
    .p { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; width: min(560px, calc(100vw - 32px)); max-height: min(78vh, 760px);
      display: flex; flex-direction: column; border-radius: 8px; background: #090b0c; color: #b3b0af;
      font: 400 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      box-shadow: inset 0 0 0 1px #363738, 0 40px 32px rgba(0,0,0,.18), 0 22px 18px rgba(0,0,0,.2), 0 6px 5px rgba(0,0,0,.18); }
    .hd { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px 14px; }
    .tag { flex: 1; font-size: 12px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: #8a8b8a; }
    .tag::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 8px; border-radius: 50%; background: #e9e1dc; vertical-align: 1px; }
    .tabs { display: flex; gap: 2px; margin: 0 12px; padding: 2px; border-radius: 8px; background: #07090b; }
    .tabs button { flex: 1; height: 28px; border: 0; border-radius: 6px; background: none; color: #8a8b8a; font: inherit; cursor: pointer; }
    .tabs button.on { background: #1a1d1e; color: #efefed; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; }
    .bar label { display: flex; align-items: center; gap: 6px; color: #8a8b8a; font-size: 12px; }
    .body { overflow: auto; overscroll-behavior: contain; padding: 0 12px 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
    .cell { position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: #07090b; box-shadow: inset 0 0 0 1px #262727; cursor: pointer; }
    .cell img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .cell.sel { box-shadow: inset 0 0 0 2px #3e7edf; }
    .cell .dim { position: absolute; left: 4px; bottom: 4px; padding: 0 5px; border-radius: 4px; background: rgba(7,9,11,.82); color: #efefed; font: 11px/18px "JetBrains Mono", ui-monospace, monospace; }
    .cell .ck { position: absolute; top: 4px; left: 4px; width: 18px; height: 18px; border-radius: 4px; background: rgba(7,9,11,.7); box-shadow: inset 0 0 0 1px #696a68; }
    .cell.sel .ck { background: #3e7edf; box-shadow: none; }
    .cell.sel .ck::after { content: ""; position: absolute; left: 6px; top: 2px; width: 5px; height: 10px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .row { display: grid; gap: 6px; padding: 10px; border-radius: 6px; background: #07090b; }
    .row + .row { margin-top: 6px; }
    .row .t { color: #efefed; font-weight: 500; overflow-wrap: anywhere; }
    .row .u { font: 11px/1.5 "JetBrains Mono", ui-monospace, monospace; color: #8a8b8a; overflow-wrap: anywhere; max-height: 3em; overflow: hidden; }
    .row .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .row.m { grid-template-columns: 128px minmax(0, 1fr); gap: 10px; align-items: start; }
    .row .info { display: grid; gap: 6px; min-width: 0; }
    .th { position: relative; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #000; box-shadow: inset 0 0 0 1px #262727; cursor: pointer; }
    .th video { width: 100%; height: 100%; object-fit: contain; display: block; }
    .th:empty::after, .th.none::after { content: attr(data-note); position: absolute; inset: 0; display: grid; place-items: center; color: #696a68; font-size: 11px; text-align: center; }
    .th.none video { display: none; }
    .k { display: inline-block; padding: 0 6px; border-radius: 4px; background: #1a1d1e; color: #efefed; font: 11px/18px "JetBrains Mono", ui-monospace, monospace; }
    button.b { height: 30px; padding: 0 12px; border: 0; border-radius: 6px; background: none; color: #efefed; font: inherit; cursor: pointer; box-shadow: inset 0 0 0 1px #363738; }
    button.b:hover { box-shadow: inset 0 0 0 1px #696a68; } button.b:disabled { opacity: .4; cursor: default; }
    button.pri { background: #e9e1dc; color: #07090b; box-shadow: none; }
    button.x { width: 30px; padding: 0; box-shadow: none; color: #8a8b8a; }
    select { height: 30px; padding: 0 8px; border: 0; border-radius: 6px; background: #1a1d1e; color: #efefed; font: inherit; }
    input[type=number] { width: 64px; height: 28px; padding: 0 6px; border: 0; border-radius: 6px; background: #1a1d1e; color: #efefed; font: inherit; }
    .prog { height: 4px; border-radius: 2px; background: #262727; overflow: hidden; } .prog i { display: block; height: 100%; width: 0; background: #55bc82; transition: width .2s; }
    .msg { font-size: 12px; color: #8a8b8a; } .msg.err { color: #ff6a5c; } .msg.ok { color: #55bc82; }
    .empty { padding: 24px 8px; text-align: center; color: #8a8b8a; }
    button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #3e7edf; outline-offset: 2px; }
  `;
  let host, root, fab, panel, tab = store.get("tab", "video"), minSize = store.get("min", 150);
  const picked = new Set(), jobs = new Map(); // url → { ctl, frac, text, err, done }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (t, run, cls = "b") => { const b = mk("button", cls, t); b.type = "button"; b.onclick = run; return b; };
  const groups = () => {
    const g = { video: [], image: [], audio: [] };
    for (const it of found.values()) if (!partOf.has(it.url)) (it.kind === "image" ? g.image : it.kind === "audio" ? g.audio : g.video).push(it);
    g.video.sort((a, b) => (b.kind === "hls") - (a.kind === "hls") || (b.kind === "video") - (a.kind === "video"));
    return g;
  };
  function mount() {
    if (host || !document.body) return;
    host = mk("div"); host.id = "omni-downloader"; root = host.attachShadow({ mode: "closed" });
    root.append(mk("style", null, css));
    fab = btn("", () => toggle(), "fab"); fab.title = "Omni Downloader (Alt+D)";
    root.append(fab); document.documentElement.append(host); drawFab();
  }
  function drawFab() {
    if (!fab) return;
    const n = groups(), media = n.video.length + n.audio.length;
    fab.replaceChildren("⬇", mk("b", null, media ? `${media} media · ${n.image.length}` : String(n.image.length)));
    fab.style.display = store.get("fab", true) || panel ? "" : "none";
  }
  let drawT = 0;
  onChange = () => { clearTimeout(drawT); drawT = setTimeout(() => { drawFab(); if (panel && tab !== "image") draw(); }, 400); };
  function toggle() {
    mount(); if (!root) return;
    if (panel) { panel.remove(); panel = null; drawFab(); return; }
    try { scan(); } catch {}
    panel = mk("div", "p"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Omni Downloader");
    root.append(panel); draw(); drawFab();
  }
  function draw() {
    if (!panel) return;
    for (const it of found.values()) if (it.kind === "hls") hlsLoad(it);
    const g = groups(), body = panel.querySelector(".body"), keep = body ? body.scrollTop : 0;
    panel.replaceChildren();
    const hd = mk("div", "hd"); hd.append(mk("span", "tag", "Omni Downloader"), btn("Rescan", () => { try { scan(); } catch {} draw(); }), btn("✕", () => toggle(), "b x"));
    hd.lastChild.setAttribute("aria-label", "Close"); panel.append(hd);
    const tabs = mk("div", "tabs");
    for (const [k, t] of [["video", "Video"], ["image", "Images"], ["audio", "Audio"]]) {
      const n = k === "image" ? g.image.filter(big).length : g[k].length;
      const b = btn(`${t} · ${n}`, () => { tab = k; store.set("tab", k); draw(); }, k === tab ? "on" : ""); b.setAttribute("aria-pressed", String(k === tab)); tabs.append(b);
    }
    panel.append(tabs);
    const nb = mk("div", "body");
    if (tab === "image") drawImages(g.image, nb); else drawMedia(g[tab], nb);
    panel.append(nb); nb.scrollTop = keep; drawFab();
  }
  const big = (it) => !it.w || (it.w >= minSize && it.h >= minSize) || it.kind !== "image";

  function drawImages(list, nb) {
    const shown = list.filter(big), bar = mk("div", "bar");
    const min = mk("input"); min.type = "number"; min.min = "0"; min.step = "50"; min.value = minSize;
    min.onchange = () => { minSize = Math.max(0, +min.value || 0); store.set("min", minSize); draw(); };
    const l = mk("label"); l.append("Smallest", min, "px"); bar.append(l);
    const sel = shown.filter((it) => picked.has(it.url));
    bar.append(btn(sel.length === shown.length && shown.length ? "Select none" : "Select all", () => { if (sel.length === shown.length) shown.forEach((x) => picked.delete(x.url)); else shown.forEach((x) => picked.add(x.url)); draw(); }));
    const zip = btn(sel.length ? `ZIP ${sel.length}` : "ZIP", () => saveZip(sel, zip, msg), "b pri"); zip.disabled = !sel.length;
    const each = btn("One by one", () => saveEach(sel, msg)); each.disabled = !sel.length;
    const msg = mk("span", "msg"); bar.append(zip, each, msg);
    panel.append(bar);
    if (!shown.length) return nb.append(mk("p", "empty", list.length ? `No images of ${minSize}px or more: lower the number above.` : "No images found yet."));
    const grid = mk("div", "grid");
    for (const it of shown) {
      const c = mk("div", "cell" + (picked.has(it.url) ? " sel" : "")); c.tabIndex = 0; c.title = it.url; c.setAttribute("role", "checkbox"); c.setAttribute("aria-checked", String(picked.has(it.url)));
      const im = mk("img"); im.loading = "lazy"; im.referrerPolicy = "no-referrer-when-downgrade"; im.src = it.url;
      im.onload = () => { if (!it.w) { it.w = im.naturalWidth; it.h = im.naturalHeight; dim.textContent = `${it.w}×${it.h}`; } };
      const dim = mk("span", "dim", it.w ? `${it.w}×${it.h}` : "");
      c.append(im, mk("span", "ck"), dim);
      const flip = () => { picked.has(it.url) ? picked.delete(it.url) : picked.add(it.url); draw(); };
      c.onclick = flip; c.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } };
      c.ondblclick = (e) => { e.stopPropagation(); saveDirect(it).catch(() => {}); };
      grid.append(c);
    }
    nb.append(grid);
  }
  async function saveEach(list, msg) {
    let ok = 0, bad = 0;
    for (const it of list) { msg.textContent = `Saving ${ok + bad + 1} of ${list.length}…`; try { await saveDirect(it); ok++; } catch { bad++; } }
    msg.className = "msg " + (bad ? "err" : "ok"); msg.textContent = `${ok} saved${bad ? `, ${bad} failed` : ""}.`;
  }
  async function saveZip(list, b, msg) {
    const ff = W.fflate || window.fflate || (typeof fflate !== "undefined" ? fflate : null);
    if (!ff?.zip) return saveEach(list, msg);
    b.disabled = true; const files = {}, names = new Set(); let bad = 0, n = 0;
    await Promise.all(list.map(async (it) => {
      try {
        const buf = await getRetry(it.url, "buffer", it.referer);
        let name = fileName(it, "jpg"), i = 1; while (names.has(name)) name = name.replace(/(\.\w+)?$/, ` (${++i})$1`); names.add(name);
        files[name] = [new Uint8Array(buf), { level: 0 }]; // images are compressed already
      } catch { bad++; }
      msg.textContent = `Fetching ${++n} of ${list.length}…`;
    }));
    ff.zip(files, (err, data) => {
      b.disabled = false;
      if (err) { msg.className = "msg err"; msg.textContent = "Couldn't make the ZIP."; return; }
      saveBlob(new Blob([data], { type: "application/zip" }), `${clean(document.title)} images.zip`);
      msg.className = "msg " + (bad ? "err" : "ok"); msg.textContent = `${Object.keys(files).length} in the ZIP${bad ? `, ${bad} couldn't be fetched` : ""}.`;
    });
  }

  function drawMedia(list, nb) {
    if (!list.length) {
      nb.append(mk("p", "empty", tab === "video" ? "No video found yet. Press play, then look again: streams show up once the player loads them." : "No audio found yet."));
      return;
    }
    for (const it of list) {
      const row = mk("div", "row m"), info = mk("div", "info"), job = jobs.get(it.url);
      row.append(thumb(it), info);
      info.append(mk("div", "t", rowTitle(it)), mk("div", "u", it.url));
      const acts = mk("div", "acts");
      if (it.kind === "hls") hlsActs(it, acts, job);
      else if (it.kind === "dash") acts.append(mk("span", "msg", "DASH isn't saved here: copy the ffmpeg command."));
      else acts.append(btn("Save", async (e) => { const b = e.currentTarget; b.disabled = true; try { await saveDirect(it); b.textContent = "Saved"; } catch (x) { b.textContent = `Failed: ${x.message}`; } }, "b pri"));
      acts.append(btn("Copy URL", () => copy(it.url)), btn("Copy ffmpeg", () => copy(`ffmpeg -headers "Referer: ${it.referer || location.href}\\r\\n" -i "${it.url}" -c copy "${fileName(it, "mp4").replace(/\.\w+$/, "")}.mp4"`)));
      info.append(acts);
      if (job) {
        const pr = mk("div", "prog"), bar = mk("i"); bar.style.width = `${Math.round((job.frac || 0) * 100)}%`; pr.append(bar);
        info.append(pr, mk("div", "msg" + (job.err ? " err" : job.done ? " ok" : ""), job.err || job.text || ""));
        job.bar = bar; job.row = info;
      }
      nb.append(row);
    }
  }
  // ---------- thumbnails ----------
  // a file plays its own first frame (metadata only, so little is loaded); a stream gets one built from its first part at
  // the lowest quality. Each element is made once and moved between redraws, so nothing reloads. Click to play / pause.
  const clock = (d) => !isFinite(d) || !d ? "" : `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}`;
  function rowTitle(it) {
    const m = it.meta || {}, top = it.variants?.find((v) => v.res)?.res.split("x")[1];
    const w = it.kind === "hls" ? 0 : m.w || it.w, h = it.kind === "hls" ? 0 : m.h || it.h, d = it.kind === "hls" ? it.dur : m.d;
    const label = it.kind === "video" && m.loaded && !m.w ? "Sound only (video file)" : { hls: "HLS stream", dash: "DASH stream", video: "Video file", audio: "Audio file" }[it.kind] || it.kind;
    return [label, it.frame && "in a frame", w && h && `${w}×${h}`, top && `up to ${top}p`, clock(d)].filter(Boolean).join(" · ");
  }
  function thumb(it) {
    if (it.thumb) return it.thumb;
    const box = mk("div", "th"); box.dataset.note = it.kind === "dash" ? "No preview" : "Loading…"; it.thumb = box;
    box.onclick = () => { const v = box.querySelector("video"); if (v) v.paused ? v.play().catch(() => {}) : v.pause(); };
    if (it.kind === "video" || it.kind === "audio") preview(it, it.url);
    return box;
  }
  function preview(it, src) {
    const v = mk("video"); v.muted = true; v.playsInline = true; v.loop = true; v.preload = "metadata";
    v.src = /^blob:/.test(src) || src.includes("#") ? src : `${src}#t=0.5`;
    v.onloadedmetadata = () => {
      if (/^blob:/.test(src) && isFinite(v.duration)) v.currentTime = Math.min(2, v.duration / 2); // streams often open on black
      it.meta = { ...(it.kind === "hls" ? {} : { d: v.duration }), w: v.videoWidth, h: v.videoHeight, loaded: true };
      const t = it.thumb.nextSibling?.querySelector(".t"); if (t) t.textContent = rowTitle(it);
      if (!v.videoWidth) { it.thumb.classList.add("none"); it.thumb.dataset.note = "Sound only"; }
    };
    v.onerror = () => { it.thumb.classList.add("none"); it.thumb.dataset.note = "No preview"; };
    it.thumb.replaceChildren(v);
  }
  async function streamThumb(it) {
    try {
      const vids = it.variants.filter((v) => v.res || v.url === it.url), v = vids[vids.length - 1] || it.variants[0];
      const media = parseMedia(await getRetry(v.url, "text", it.referer), v.url);
      if (media.drm || !media.segs.length) throw 0;
      const ctl = new AbortController(), seg = await decrypt(await getPart(media.segs[0], it.referer, ctl.signal), media.segs[0], it.referer, ctl.signal);
      const blob = media.map ? new Blob([await getPart(media.map, it.referer, ctl.signal), seg], { type: "video/mp4" }) : tsToMp4([seg]);
      if (!blob) throw 0;
      if (!it.dur) it.dur = media.dur;
      preview(it, URL.createObjectURL(blob));
    } catch { it.thumb?.classList.add("none"); if (it.thumb) it.thumb.dataset.note = "No preview"; }
  }

  // a stream's playlist, read once: its qualities (which then stop showing as rows of their own) and audio tracks
  function hlsLoad(it) {
    if (it.variants || it.loading || partOf.has(it.url)) return;
    it.loading = true;
    {
      getRetry(it.url, "text", it.referer).then((t) => {
        const m = parseMaster(t, it.url);
        it.variants = m.variants.length ? m.variants : [{ url: it.url, res: "", bw: 0 }]; it.audioTracks = m.audio;
        for (const v of m.variants) if (v.url !== it.url) partOf.add(v.url);
        if (!m.variants.length) { const md = parseMedia(t, it.url); it.dur = md.dur; it.info = `${md.segs.length} parts${md.dur ? ` · ${Math.round(md.dur / 60)} min` : ""}${md.live ? " · live (saves what's listed now)" : ""}${md.drm ? " · DRM" : ""}`; }
        thumb(it); streamThumb(it);
      }, (e) => { it.variants = []; it.err = e.message; }).finally(() => { it.loading = false; draw(); });
    }
  }
  function hlsActs(it, acts, job) {
    const running = job && !job.done && !job.err;
    hlsLoad(it);
    if (it.err) return acts.append(mk("span", "msg err", `Playlist unreadable: ${it.err}`));
    if (!it.variants) return acts.append(mk("span", "msg", "Reading the playlist…"));
    const s = mk("select"); s.setAttribute("aria-label", "Quality");
    const mbps = (v) => v.bw ? ` · ${(v.bw / 1e6).toFixed(1)} Mb/s` : "";
    it.variants.forEach((v, i) => s.append(new Option(v.res ? `${v.res.split("x")[1]}p${mbps(v)}` : v.url === it.url ? it.info || "Single quality"
      : v.codecs && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs) ? `Sound only${mbps(v)}` : `Quality ${i + 1}${mbps(v)}`, String(i), false, i === (it.pick || 0))));
    s.onchange = () => { it.pick = +s.value; };
    s.disabled = running; if (it.variants.length > 1 || !it.info) acts.append(s); else acts.append(mk("span", "msg", it.info));
    const ts = mk("label", "msg"), cb = mk("input"); cb.type = "checkbox"; cb.checked = !!it.asTs; cb.onchange = () => { it.asTs = cb.checked; }; ts.append(cb, " keep .ts");
    if (running) acts.append(btn("Stop", () => job.ctl.abort()));
    else acts.append(btn("Save video", () => runHls(it), "b pri"), ts);
    const v = it.variants[it.pick || 0];
    if (v?.audio && it.audioTracks?.some((a) => a.group === v.audio)) acts.append(mk("span", "msg", "Sound is a separate track here: save it from the Audio tab or with ffmpeg."));
    if (it.audioTracks?.length && !it.audioAdded) { it.audioAdded = true; for (const a of it.audioTracks) found.set(a.url, { url: a.url, kind: "audio", referer: it.referer, title: `${it.title || document.title} ${a.name}`, hlsAudio: true }); }
  }
  async function runHls(it) {
    const ctl = new AbortController(), job = { ctl, frac: 0, text: "Starting…" }; jobs.set(it.url, job); draw();
    const ui = { signal: ctl.signal, progress: (f, t) => { job.frac = f; job.text = t; if (job.bar?.isConnected) { job.bar.style.width = `${Math.round(f * 100)}%`; job.row.lastChild.textContent = t; } } };
    try {
      const v = { ...it.variants[it.pick || 0], asTs: it.asTs };
      const media = await saveHls(it, v, ui);
      job.done = true; job.frac = 1; job.text = `Saved${media?.live ? " (a live stream: only what was listed so far)" : ""}.`;
    } catch (e) { job.err = e.name === "AbortError" ? "Stopped." : e.message; }
    draw();
  }
  function copy(t) { try { GM_setClipboard(t, "text"); } catch { navigator.clipboard?.writeText(t).catch(() => {}); } }

  // ---------- start ----------
  const ready = () => { mount(); setTimeout(() => { try { scan(); } catch {} drawFab(); }, 1500); };
  if (document.body) ready(); else document.addEventListener("DOMContentLoaded", ready, { once: true });
  window.addEventListener("keydown", (e) => { if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") { e.preventDefault(); toggle(); } }, true);
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open Omni Downloader (Alt+D)", () => toggle());
    GM_registerMenuCommand("Show / hide the floating button", () => { store.set("fab", !store.get("fab", true)); drawFab(); });
  }
})();
