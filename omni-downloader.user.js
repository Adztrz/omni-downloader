// ==UserScript==
// @name         Omni Downloader
// @namespace    https://github.com/Adztrz
// @version      1.13.1
// @description  Finds the images, videos and audio on any page, including HLS (m3u8) streams the player loads, and saves them: one file, a ZIP of many, or a whole HLS video joined into one MP4. Alt+Shift+D opens it. Can hand files and streams to Ghost Downloader.
// @author       Adztrz
// @icon         https://raw.githubusercontent.com/Adztrz/omni-downloader/master/logo-128.png
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
// @grant        GM_cookie
// @grant        GM_getResourceURL
// @grant        unsafeWindow
// @connect      *
// @connect      127.0.0.1
// @require      https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @resource     inter https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.1.0/files/inter-latin-wght-normal.woff2
// @resource     mono https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.1.1/files/jetbrains-mono-latin-wght-normal.woff2
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
  // Bilibili serves each video's picture and sound as two whole fMP4 files named .m4s under /upgcxcode/ (fetched in Range
  // pieces): files, not stream segments
  const BILI = /\/upgcxcode\/.+\.m4s(?:$|[?#])/i;
  // judged by the address's path: a query string can carry another address (trackers report what played)
  const kindOf = (url) => {
    let p = url; try { if (!/^data:/.test(url)) p = new URL(url).pathname; } catch {}
    return BILI.test(p) ? "video" : EXT.hls.test(p) ? "hls" : EXT.dash.test(p) ? "dash" : EXT.video.test(p) ? "video" : EXT.audio.test(p) ? "audio" : EXT.image.test(p) ? "image" : null;
  };
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
    if (kind !== "hls" && kind !== "dash" && SEGMENT.test(url) && !BILI.test(url)) return;
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
  // a YouTube video (watch page, Shorts, or a player embedded in another page). Its streams are locked (signed, often
  // fetched by POST), so it isn't caught from the network: it's listed as the video's own address, which Ghost Downloader
  // saves with yt-dlp. One row, for the video now showing (YouTube changes videos without loading a new page).
  function youTube() {
    if (!/(?:^|\.)youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
    const shorts = /^\/shorts\//.test(location.pathname);
    const id = new URLSearchParams(location.search).get("v") || (/^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(location.pathname) || [])[1];
    const url = id && /^[\w-]{11}$/.test(id) ? (shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`) : "";
    for (const [u, it] of found) if (it.kind === "yt" && u !== url) found.delete(u);
    if (!url) return;
    const title = (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "") || "YouTube video";
    const had = found.get(url); if (had) { if (had.title !== title) { had.title = title; changed(had); } return; } // the title follows the address
    const item = { url, kind: "yt", ytId: id, shorts, referer: url, title };
    found.set(url, item); changed(item);
  }
  function scan() {
    const d = document;
    youTube();
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

  // YouTube (and other single-page sites) change the address without loading a page: look again when it changes
  { let last = location.href; setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(() => { try { scan(); } catch {} onChange(); }, 1200); } }, 1000); }

  // ---------- fetching (cross-origin through Tampermonkey, with the page that loaded it as Referer) ----------
  // onprog(loaded, total), when given, reports a big file as it arrives (total 0 when the server doesn't say); such a
  // download has no time limit, since it may take minutes: Stop ends it
  function get(url, type, referer, signal, onprog) {
    if (typeof GM_xmlhttpRequest !== "function" || /^(blob|data):/.test(url))
      return fetch(url, { signal, credentials: new URL(url, location.href).origin === location.origin ? "include" : "omit" }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (type === "text") return r.text();
        if (!onprog || !r.body) return r.arrayBuffer();
        const total = +r.headers.get("content-length") || 0, rd = r.body.getReader(), chunks = []; let n = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; onprog(n, total); }
        return new Blob(chunks).arrayBuffer();
      });
    return new Promise((resolve, reject) => {
      const req = GM_xmlhttpRequest({
        method: "GET", url, responseType: type === "text" ? "text" : "arraybuffer", anonymous: false,
        headers: referer ? { Referer: referer } : {},
        onload: (r) => r.status >= 200 && r.status < 300 ? resolve(type === "text" ? r.responseText : r.response) : reject(new Error(`HTTP ${r.status}`)),
        onerror: () => reject(new Error("network error")), ontimeout: () => reject(new Error("timed out")), timeout: onprog ? 0 : 60000,
        ...(onprog ? { onprogress: (e) => onprog(e.loaded, e.lengthComputable || e.total > 0 ? e.total : 0) } : {}),
      });
      signal?.addEventListener("abort", () => { try { req.abort(); } catch {} reject(new DOMException("Stopped", "AbortError")); });
    });
  }
  async function getRetry(url, type, referer, signal, tries = 3, onprog) {
    for (let i = 1; ; i++) {
      try { return await get(url, type, referer, signal, onprog); }
      catch (e) { if (signal?.aborted || i >= tries) throw e; await new Promise((r) => setTimeout(r, 600 * i)); }
    }
  }
  let lastSaved = ""; // the name of the file just saved, for the row's "Saved as …"
  const saveFile = (blob, name) => saveBlob(blob, name);
  function saveBlob(blob, name) {
    lastSaved = name;
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
  // returns a note for the Save button, if there's something to say; ui = { signal, progress(fraction, text) } as for HLS
  const quiet = { signal: undefined, progress: () => {} };
  // a progress reporter for one file: "Picture 12 MB of 40 MB"; with two files (picture, then sound) each fills half the bar
  const fileProg = (ui, label, from = 0, span = 1) => (n, total) =>
    ui.progress(total ? from + span * Math.min(1, n / total) : from, `${label ? label + " " : ""}${bytes(n)}${total ? ` of ${bytes(total)}` : ""}`);
  async function saveDirect(it, ui = quiet) {
    if (it.hlsAudio || EXT.hls.test(it.url)) return saveHlsAudio(it, ui);
    const name = fileName(it, it.kind === "image" ? "jpg" : it.kind === "audio" ? "mp3" : "mp4");
    if (it.kind === "video" && /^https?:/.test(it.url)) return saveVideo(it, BILI.test(it.url) ? `${clean(it.title || document.title)}.mp4` : name, ui);
    if (typeof GM_download === "function" && /^https?:/.test(it.url)) {
      try {
        await new Promise((resolve, reject) => {
          const d = GM_download({ url: it.url, name, headers: { Referer: it.referer || location.href }, onload: resolve, onerror: (e) => reject(new Error(e?.error || "download failed")), ontimeout: () => reject(new Error("timed out")),
            onprogress: (e) => fileProg(ui, "")(e.loaded || 0, e.lengthComputable || e.total > 0 ? e.total : 0) });
          ui.signal?.addEventListener("abort", () => { try { d?.abort(); } catch {} reject(new DOMException("Stopped", "AbortError")); });
        });
        lastSaved = name; return;
      } catch (e) { if (!/not_whitelisted|not_enabled|not_permitted/i.test(String(e.message))) throw e; } // file type not allowed in Tampermonkey's settings: save it ourselves
    }
    saveBlob(new Blob([await getRetry(it.url, "buffer", it.referer, ui.signal, 3, fileProg(ui, ""))]), name);
  }

  // ---------- picture and sound in separate files (Instagram, Facebook and other DASH players) ----------
  // Such a site keeps a video's picture in one MP4 and its sound in another, and its player plays both. Save fetches the
  // picture file, and when it has no sound track, finds the sound file that goes with it (the same asset id in Instagram's
  // efg parameter, else the same length) and joins the two into one MP4 with both tracks. Nothing is re-encoded: the boxes
  // are copied and only track numbers, timescales and offsets are rewritten. Fragmented MP4 (what DASH serves) and plain
  // MP4 with one mdat are both handled; anything else is saved as it came.
  async function saveVideo(it, name, ui = quiet) {
    const r = await saveVideoWhole(it, name, ui, it.trim);
    return r;
  }
  async function saveVideoWhole(it, name, ui, trim) {
    let untrimmed = false;
    const saveBlob = (blob, nm) => { // the same save, cut first when a stretch is chosen and the file allows it
      if (!trim || !/^video|^audio\/mp4/.test(blob.type)) return saveFile(blob, nm);
      return blob.arrayBuffer().then((buf) => {
        const cut = trimFrag(new Uint8Array(buf), trim.start, trim.end);
        if (cut) return saveFile(new Blob(cut, { type: blob.type }), nm.replace(/(\.\w+)$/, ` ${trimName(trim)}$1`));
        untrimmed = true; saveFile(blob, nm);
      });
    };
    const note = await saveVideoInner(it, name, ui, saveBlob);
    return untrimmed ? `${note ? note + ". " : ""}Saved whole: a plain MP4 can't be cut in the browser. Copy the ffmpeg command for an exact cut` : note;
  }
  async function saveVideoInner(it, name, ui, saveBlob) {
    // where the sound is likely a file of its own (an Instagram or Bilibili id), the picture fills the first half of the bar
    const split = !!assetKey(it.url) && 0.5;
    const V = new Uint8Array(await getRetry(it.url, "buffer", it.referer, ui.signal, 3, fileProg(ui, split ? "Picture" : "", 0, split || 1))), vi = mp4Info(V);
    const has = (info, h) => !!info?.traks.some((t) => t.handler === h);
    if (vi && !has(vi, "vide") && has(vi, "soun")) { await saveBlob(new Blob([V], { type: "audio/mp4" }), name.replace(/\.\w+$/, "") + ".m4a"); return "Saved (sound only)"; }
    if (!has(vi, "vide") || has(vi, "soun")) { await saveBlob(new Blob([V], { type: "video/mp4" }), name); return ""; }
    ui.progress(split || 0, "Finding its sound…");
    const pair = await soundFor(it);
    if (pair) {
      try {
        const A = new Uint8Array(await getRetry(pair.url, "buffer", pair.referer || it.referer, ui.signal, 3, fileProg(ui, "Sound", split || 0, split || 1))), ai = mp4Info(A);
        if (has(ai, "soun") && !has(ai, "vide") && ai.frag === vi.frag) {
          ui.progress(1, "Joining picture and sound…"); await new Promise((r) => setTimeout(r, 30));
          await saveBlob(new Blob(vi.frag ? joinFragmented(V, vi, A, ai) : joinPlain(V, vi, A, ai), { type: "video/mp4" }), name);
          return "Saved with sound";
        }
      } catch (e) { if (e.name === "AbortError") throw e; console.warn("[omni] joining picture and sound failed:", e); }
    }
    await saveBlob(new Blob([V], { type: "video/mp4" }), name);
    return pair ? "Saved without sound (couldn't join)" : "Saved without sound: play the video so its sound loads, then save again";
  }
  // the sound file for a picture-only file: same Instagram asset id or Bilibili cid, else the closest length (within a second)
  const assetKey = (u) => {
    try {
      const bili = BILI.test(u) && /\/upgcxcode\/\d+\/\d+\/(\d+)\//.exec(u); if (bili) return `bili:${bili[1]}`;
      const e = new URL(u).searchParams.get("efg"); if (!e) return "";
      const j = JSON.parse(atob(e.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(e.length / 4) * 4, "=")));
      return String(j.xpv_asset_id ?? j.asset_id ?? j.video_id ?? "");
    } catch { return ""; }
  };
  function probe(it) {
    if (it.meta?.loaded) return Promise.resolve(it.meta);
    return new Promise((resolve) => {
      const v = document.createElement("video"); v.muted = true; v.preload = "metadata";
      const done = () => { clearTimeout(t); it.meta = { w: v.videoWidth, h: v.videoHeight, d: v.duration, loaded: !!v.duration }; v.removeAttribute("src"); v.load(); resolve(it.meta); };
      const t = setTimeout(done, 8000); v.onloadedmetadata = done; v.onerror = done; v.src = it.url;
    });
  }
  async function soundFor(it) {
    const key = assetKey(it.url), others = [...found.values()].filter((x) => x !== it && (x.kind === "video" || x.kind === "audio") && /^https?:/.test(x.url));
    const same = key ? others.filter((x) => assetKey(x.url) === key) : [];
    const pool = (same.length ? same : others).slice(0, 40), me = await probe(it);
    const sound = [];
    for (const x of pool) { const m = await probe(x); if (m.loaded && !m.w) sound.push({ x, gap: Math.abs((m.d || 0) - (me.d || 0)) }); }
    sound.sort((a, b) => a.gap - b.gap);
    return sound.length && (same.length || sound[0].gap < 1) ? sound[0].x : null;
  }

  // MP4 boxes: [size][type][body], size 1 = 64-bit size follows, 0 = to the end
  const t4 = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  const dv = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
  function boxes(u, start = 0, end = u.length) {
    const d = dv(u), out = [];
    for (let o = start; o + 8 <= end;) {
      let size = d.getUint32(o), hdr = 8;
      if (size === 1) { size = Number(d.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type: t4(u, o + 4), start: o, end: o + size, body: o + hdr }); o += size;
    }
    return out;
  }
  const kids = (u, b) => boxes(u, b.body, b.end);
  const find = (u, b, path) => { let c = b; for (const t of path.split("/")) { c = c && kids(u, c).find((x) => x.type === t); } return c || null; };
  const box = (type, parts) => {
    const n = 8 + parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
    dv(out).setUint32(0, n); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  };
  const getN = (d, o, wide) => wide ? Number(d.getBigUint64(o)) : d.getUint32(o);
  const setN = (d, o, wide, v) => wide ? d.setBigUint64(o, BigInt(Math.round(v))) : d.setUint32(o, Math.round(v));
  function mp4Info(u) {
    const top = boxes(u), moov = top.find((b) => b.type === "moov"); if (!moov) return null;
    const traks = kids(u, moov).filter((b) => b.type === "trak").map((t) => { const h = find(u, t, "mdia/hdlr"); return { box: t, handler: h ? t4(u, h.body + 8) : "" }; });
    return { top, moov, traks, frag: !!find(u, moov, "mvex") };
  }
  const mvhdScale = (u, moov) => { const m = find(u, moov, "mvhd"); return dv(u).getUint32(m.body + 4 + (u[m.body] ? 16 : 8)); };
  // the sound trak, copied: its track number changed, and its movie-timescale durations moved to the picture file's timescale
  function soundTrak(A, ai, id, scale) {
    const t = ai.traks.find((x) => x.handler === "soun").box, c = A.slice(t.start, t.end), d = dv(c), root = boxes(c)[0];
    const tk = find(c, root, "tkhd"), v1 = c[tk.body] === 1;
    d.setUint32(tk.body + 4 + (v1 ? 16 : 8), id);
    const durAt = tk.body + 4 + (v1 ? 16 : 8) + 8; setN(d, durAt, v1, getN(d, durAt, v1) * scale);
    const el = find(c, root, "edts/elst");
    if (el) { const w = c[el.body] === 1, n = d.getUint32(el.body + 4); for (let i = 0, o = el.body + 8; i < n; i++, o += w ? 20 : 12) setN(d, o, w, getN(d, o, w) * scale); }
    return c;
  }
  // the picture file's mvhd with next_track_ID past the sound's, and its duration the longer of the two
  function newMvhd(V, vi, id, aDur) {
    const m = find(V, vi.moov, "mvhd"), c = V.slice(m.start, m.end), d = dv(c), v1 = c[8] === 1;
    d.setUint32(8 + (v1 ? 108 : 96), id + 1);
    const durAt = 8 + 4 + (v1 ? 16 : 8) + 4; if (aDur > getN(d, durAt, v1)) setN(d, durAt, v1, aDur);
    return c;
  }
  const trackId = (u, trak) => { const tk = find(u, trak, "tkhd"); return dv(u).getUint32(tk.body + 4 + (u[tk.body] ? 16 : 8)); };
  const mdhdScale = (u, trak) => { const m = find(u, trak, "mdia/mdhd"); return dv(u).getUint32(m.body + 4 + (u[m.body] ? 16 : 8)); };
  const soundDur = (A, ai) => { const m = find(A, ai.moov, "mvhd"), v1 = A[m.body] === 1; return getN(dv(A), m.body + 4 + (v1 ? 16 : 8) + 4, v1); };
  function joinFragmented(V, vi, A, ai) {
    const id = Math.max(...vi.traks.map((t) => trackId(V, t.box))) + 1, scale = mvhdScale(V, vi.moov) / mvhdScale(A, ai.moov);
    const aTrak = ai.traks.find((x) => x.handler === "soun").box, aOld = trackId(A, aTrak);
    const ts = { v: Object.fromEntries(vi.traks.map((t) => [trackId(V, t.box), mdhdScale(V, t.box)])), a: mdhdScale(A, aTrak) };
    const mvex = find(V, vi.moov, "mvex"), aTrex = kids(A, find(A, ai.moov, "mvex")).find((b) => b.type === "trex" && dv(A).getUint32(b.body + 4) === aOld);
    const trex = A.slice(aTrex.start, aTrex.end); dv(trex).setUint32(12, id);
    const moov = box("moov", [newMvhd(V, vi, id, soundDur(A, ai) * scale),
      ...kids(V, vi.moov).filter((b) => b.type !== "mvhd" && b.type !== "mvex").map((b) => V.subarray(b.start, b.end)),
      soundTrak(A, ai, id, scale), box("mvex", [...kids(V, mvex).map((b) => V.subarray(b.start, b.end)), trex])]);
    // each moof with the mdat(s) after it, timed by its tfdt, so picture and sound fragments interleave by time
    const frags = (u, info, sound) => {
      const out = []; let cur = null;
      for (const b of info.top) {
        if (b.type === "moof") {
          const traf = find(u, b, "traf"), tfdt = traf && find(u, traf, "tfdt"), tid = traf ? dv(u).getUint32(find(u, traf, "tfhd").body + 4) : 0;
          const t = tfdt ? getN(dv(u), tfdt.body + 4, u[tfdt.body] === 1) / (sound ? ts.a : ts.v[tid] || 1) : out.length;
          out.push(cur = { u, moof: b, mdats: [], t, sound });
        } else if (b.type === "mdat" && cur) cur.mdats.push(b);
      }
      return out;
    };
    const all = [...frags(V, vi, false), ...frags(A, ai, true)].sort((x, y) => x.t - y.t || x.sound - y.sound);
    const ftyp = vi.top.find((b) => b.type === "ftyp"), parts = [ftyp ? V.subarray(ftyp.start, ftyp.end) : box("ftyp", [new TextEncoder().encode("isom"), new Uint8Array(4), new TextEncoder().encode("isomiso6mp41")]), moov];
    let pos = parts.reduce((a, p) => a + p.length, 0), seq = 0;
    for (const f of all) {
      const m = f.u.slice(f.moof.start, f.moof.end), d = dv(m), root = boxes(m)[0];
      d.setUint32(find(m, root, "mfhd").body + 4, ++seq);
      for (const traf of kids(m, root).filter((b) => b.type === "traf")) {
        const tf = find(m, traf, "tfhd"), flags = d.getUint32(tf.body) & 0xffffff;
        if (f.sound) d.setUint32(tf.body + 4, id);
        if (flags & 1) setN(d, tf.body + 8, true, getN(d, tf.body + 8, true) - f.moof.start + pos); // absolute offsets move with the fragment
      }
      parts.push(m); pos += m.length;
      for (const b of f.mdats) { parts.push(f.u.subarray(b.start, b.end)); pos += b.end - b.start; }
    }
    return parts;
  }
  function joinPlain(V, vi, A, ai) {
    const vm = vi.top.filter((b) => b.type === "mdat"), am = ai.top.filter((b) => b.type === "mdat");
    if (vm.length !== 1 || am.length !== 1) throw new Error("more than one mdat");
    const id = Math.max(...vi.traks.map((t) => trackId(V, t.box))) + 1, scale = mvhdScale(V, vi.moov) / mvhdScale(A, ai.moov);
    const ftyp = vi.top.find((b) => b.type === "ftyp"), head = ftyp ? V.subarray(ftyp.start, ftyp.end) : new Uint8Array(0);
    const moov = box("moov", [newMvhd(V, vi, id, soundDur(A, ai) * scale), ...kids(V, vi.moov).filter((b) => b.type !== "mvhd").map((b) => V.slice(b.start, b.end)), soundTrak(A, ai, id, scale)]);
    // chunk offsets point into each file's mdat: move them to where that mdat now sits
    const vAt = head.length + moov.length, aAt = vAt + (vm[0].end - vm[0].start), d = dv(moov), root = boxes(moov)[0];
    kids(moov, root).filter((b) => b.type === "trak").forEach((t, i) => {
      const delta = i < vi.traks.length ? vAt - vm[0].start : aAt - am[0].start;
      for (const name of ["stco", "co64"]) {
        const c = find(moov, t, `mdia/minf/stbl/${name}`); if (!c) continue;
        const wide = name === "co64", n = d.getUint32(c.body + 4);
        for (let k = 0, o = c.body + 8; k < n; k++, o += wide ? 8 : 4) setN(d, o, wide, getN(d, o, wide) + delta);
      }
    });
    return [head, moov, V.subarray(vm[0].start, vm[0].end), A.subarray(am[0].start, am[0].end)];
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
    const segs = []; let key = null, map = null, seq = 0, dur = 0, range = null, lastEnd = 0, drm = "", len = 0;
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
      else if (l.startsWith("#EXTINF:")) { len = parseFloat(l.slice(8)) || 0; dur += len; }
      else if (l.startsWith("#EXT-X-BYTERANGE:")) range = byterange(l.slice(17));
      else if (!l.startsWith("#")) { segs.push({ url: abs(l, base), key, seqNo: seq + segs.length, range, t: dur - len, d: len }); range = null; len = 0; }
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
    const trim = choice.trim && trimSegs(media, choice.trim);
    const parts = await getSegments(media, ref, signal, (d, n) => ui.progress(d / n, `${d} / ${n} parts`));
    if (media.map) parts.unshift(await getPart(media.map, ref, signal));
    const base = clean(it.title || document.title) + (choice.res ? ` ${choice.res.split("x")[1]}p` : "") + (trim ? ` ${trimName(trim)}` : "");
    if (media.map) { // fMP4: already MP4 pieces; a trimmed part is retimed to start at 0
      const cut = trim && trimFrag(concat(parts.map((x) => new Uint8Array(x))), -Infinity, Infinity);
      saveBlob(new Blob(cut || parts, { type: "video/mp4" }), `${base}.mp4`); return media;
    }
    ui.progress(1, "Joining into MP4…"); await new Promise((r) => setTimeout(r, 30));
    const mp4 = choice.asTs ? null : tsToMp4(parts);
    if (mp4) saveBlob(mp4, `${base}.mp4`); else saveBlob(new Blob(parts, { type: "video/mp2t" }), `${base}.ts`);
    return media;
  }

  // an HLS audio track (found through a master playlist): its parts joined into one file
  async function saveHlsAudio(it, ui = quiet) {
    const signal = ui.signal || new AbortController().signal, media = parseMedia(await getRetry(it.url, "text", it.referer, signal), it.url);
    if (media.drm) throw new Error("DRM-protected");
    const trim = it.trim && trimSegs(media, it.trim);
    const parts = await getSegments(media, it.referer, signal, (d, n) => ui.progress(d / n, `${d} / ${n} parts`));
    if (media.map) parts.unshift(await getPart(media.map, it.referer, signal));
    saveBlob(new Blob(parts), `${clean(it.title)}${trim ? ` ${trimName(trim)}` : ""}.${media.map ? "m4a" : "aac"}`);
  }

  // ---------- trimming before download ----------
  // A stream is cut by its parts: only the parts that overlap the chosen stretch are fetched, so a few minutes of a long
  // video cost a few minutes of download. The cut lands on part edges (usually within 2-6 seconds). A fragmented MP4 is
  // cut the same way by its fragments, after download. Nothing is re-encoded. A plain MP4 can't be cut like that: it's
  // saved whole, and the ffmpeg command (with the times) cuts it exactly.
  function trimSegs(media, trim) {
    const keep = media.segs.filter((s) => s.t + s.d > trim.start && s.t < trim.end);
    if (!keep.length) throw new Error("No part of the stream falls inside that stretch. Check the start and end times.");
    media.segs = keep; return { start: keep[0].t, end: keep[keep.length - 1].t + keep[keep.length - 1].d };
  }
  const concat = (arrs) => { const out = new Uint8Array(arrs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of arrs) { out.set(x, o); o += x.length; } return out; };
  const hms = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  const trimName = (t) => `${hms(t.start)}-${hms(t.end)}`.replace(/:/g, ".");
  // "1:02:10", "62:10", "3730", "1:02:10.5" → seconds
  const parseTime = (v) => { const p = String(v).trim().split(":"); if (!p[0] || p.length > 3 || p.some((x) => !/^\d+(\.\d+)?$/.test(x))) return NaN; return p.reduce((a, x) => a * 60 + +x, 0); };
  function trimFrag(u, start, end) {
    const info = mp4Info(u); if (!info?.frag) return null;
    const d = dv(u), scales = Object.fromEntries(info.traks.map((t) => [trackId(u, t.box), mdhdScale(u, t.box)]));
    const frs = []; let cur = null;
    for (const b of info.top) {
      if (b.type === "moof") {
        let t = Infinity;
        for (const traf of kids(u, b).filter((x) => x.type === "traf")) {
          const id = d.getUint32(find(u, traf, "tfhd").body + 4), tf = find(u, traf, "tfdt");
          if (tf) t = Math.min(t, getN(d, tf.body + 4, u[tf.body] === 1) / (scales[id] || 1));
        }
        frs.push(cur = { moof: b, mdats: [], t: isFinite(t) ? t : frs.length });
      } else if (b.type === "mdat" && cur) cur.mdats.push(b);
    }
    const starts = [...new Set(frs.map((f) => f.t))].sort((a, b) => a - b), next = (t) => starts.find((x) => x > t) ?? Infinity;
    const keep = frs.filter((f) => f.t < end && next(f.t) > start);
    if (!keep.length) return null;
    const base = Math.min(...keep.map((f) => f.t)), last = Math.max(...keep.map((f) => next(f.t)));
    const moov = u.slice(info.moov.start, info.moov.end), mroot = boxes(moov)[0], mehd = find(moov, mroot, "mvex/mehd");
    if (mehd) setN(dv(moov), mehd.body + 4, moov[mehd.body] === 1, isFinite(last) ? (Math.min(last, end) - base) * mvhdScale(moov, mroot) : 0);
    const ftyp = info.top.find((b) => b.type === "ftyp"), parts = ftyp ? [u.subarray(ftyp.start, ftyp.end), moov] : [moov];
    let pos = parts.reduce((a, x) => a + x.length, 0), seq = 0;
    for (const f of keep) {
      const m = u.slice(f.moof.start, f.moof.end), md = dv(m), root = boxes(m)[0];
      md.setUint32(find(m, root, "mfhd").body + 4, ++seq);
      for (const traf of kids(m, root).filter((b) => b.type === "traf")) {
        const tf = find(m, traf, "tfhd"), flags = md.getUint32(tf.body) & 0xffffff, id = md.getUint32(tf.body + 4), dt = find(m, traf, "tfdt");
        if (dt) { const w = m[dt.body] === 1; setN(md, dt.body + 4, w, Math.max(0, getN(md, dt.body + 4, w) - base * (scales[id] || 1))); }
        if (flags & 1) setN(md, tf.body + 8, true, getN(md, tf.body + 8, true) - f.moof.start + pos); // absolute offsets move with the fragment
      }
      parts.push(m); pos += m.length;
      for (const b of f.mdats) { parts.push(u.subarray(b.start, b.end)); pos += b.end - b.start; }
    }
    return parts;
  }
  // whether a file is fragmented, from its first 256 KB (a plain MP4 keeps its index whole, often at the end)
  function fragKind(it) {
    if (it.fragP) return it.fragP;
    const read = (buf) => { const u = new Uint8Array(buf), top = boxes(u), moov = top.find((b) => b.type === "moov"); return top.some((b) => b.type === "moof") || (moov && moov.end <= u.length && find(u, moov, "mvex")) ? "frag" : "plain"; };
    it.fragP = (typeof GM_xmlhttpRequest === "function"
      ? new Promise((ok, no) => GM_xmlhttpRequest({ method: "GET", url: it.url, responseType: "arraybuffer", headers: { Range: "bytes=0-262143", Referer: it.referer || location.href }, timeout: 20000,
        onload: (r) => r.status < 300 ? ok(r.status === 206 ? r.response : r.response.slice(0, 262144)) : no(new Error(`HTTP ${r.status}`)), onerror: () => no(new Error("network error")), ontimeout: () => no(new Error("timed out")) }))
      : fetch(it.url, { headers: { Range: "bytes=0-262143" } }).then((r) => r.arrayBuffer())).then(read, () => "unknown");
    return it.fragP;
  }

  // ---------- the panel ----------
  // the ERP Dock's look: Faust's Night Ledger palette, a 48px square button, a panel that opens as a halftone wave of dots
  // from the button's corner, a filter bar on top, segmented tabs, rows that light up on hover
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab, .p, .pill { --canvas: #07090b; --card: #090b0c; --raised: #1a1d1e; --edge: #363738; --hair: #262727; --bone: #e9e1dc; --paper: #efefed; --body: #b3b0af; --muted: #8a8b8a;
      --green: #55bc82; --red: #ff6a5c; --blue: #3e7edf; --soft: cubic-bezier(.1, 0, .1, 1); --out: cubic-bezier(.22, 1, .36, 1); --swap: cubic-bezier(.76, 0, .24, 1);
      font: 400 14px/1.45 "Omni Inter", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-feature-settings: "cv11", "tnum"; -webkit-font-smoothing: antialiased; }
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 12px; cursor: pointer;
      display: grid; place-items: center; background: var(--card); color: var(--bone);
      box-shadow: inset 0 0 0 1px var(--edge), 0 12px 24px rgba(0,0,0,.35), 0 2px 4px rgba(0,0,0,.3);
      transition: transform .25s var(--out), box-shadow .25s var(--out); animation: in .6s var(--soft) both; }
    .fab:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 1px #696a68, 0 16px 28px rgba(0,0,0,.4), 0 2px 4px rgba(0,0,0,.3); }
    .fab:active { transform: scale(.94); }
    .fab svg { width: 22px; height: 22px; grid-area: 1 / 1; transition: transform .35s var(--out), opacity .2s; }
    .fab svg.open { width: 34px; height: 34px; }
    .fab svg.x { transform: rotate(-90deg) scale(.6); opacity: 0; }
    .fab[aria-expanded="true"] svg.open { transform: rotate(90deg) scale(.6); opacity: 0; } .fab[aria-expanded="true"] svg.x { transform: none; opacity: 1; }
    .fab .n { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--bone); color: var(--canvas);
      font: 600 11px/20px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; text-align: center; box-shadow: 0 0 0 2px var(--card); }
    .fab .n:empty { display: none; }
    @keyframes in { from { opacity: 0; transform: translateY(12px) scale(.9); filter: blur(2px); } }
    .p { position: fixed; right: 16px; bottom: 76px; z-index: 2147483647; width: min(560px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 120px));
      display: flex; flex-direction: column; border-radius: 10px; background: var(--card); color: var(--body); overflow: hidden; transform-origin: bottom right;
      box-shadow: inset 0 0 0 1px var(--edge), 0 40px 32px rgba(0,0,0,.18), 0 22px 18px rgba(0,0,0,.2), 0 12px 10px rgba(0,0,0,.2), 0 6px 5px rgba(0,0,0,.18), 0 2px 2px rgba(0,0,0,.2);
      animation: ht-open .5s var(--out) both; }
    .p.out { animation: ht-close .22s cubic-bezier(.5, 0, .75, 0) both; pointer-events: none; }
    /* the wave front of dots: solid behind it, a band of dots on it, nothing ahead; the mask goes once it's open */
    .p:not(.done), .p.out {
      mask: radial-gradient(circle at 100% 100%, #000 calc(var(--ht-w) - 56px), transparent calc(var(--ht-w) - 55px)) 0 0 / 100% 100% no-repeat,
        radial-gradient(circle, #000 1.6px, transparent 2.2px) 0 0 / 6px 6px,
        radial-gradient(circle at 100% 100%, #000 calc(var(--ht-w) - 8px), transparent var(--ht-w)) 0 0 / 100% 100% no-repeat;
      mask-composite: add, intersect; }
    @keyframes ht-open { from { --ht-w: 0px; transform: translateY(6px); } to { --ht-w: 1100px; transform: none; } }
    @keyframes ht-close { from { --ht-w: 900px; } to { --ht-w: 0px; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { .fab, .p, .p.out { animation: none; } .p:not(.done) { mask: none; } }

    .top { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--hair); }
    .top > svg { width: 16px; height: 16px; color: var(--muted); flex: none; }
    .top input { flex: 1; min-width: 0; height: 32px; border: 0; outline: 0; background: none; color: var(--paper); font: inherit; font-size: 15px; }
    .top input::placeholder { color: var(--muted); }
    .shut { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; flex: none; }
    .shut:hover { background: var(--raised); color: var(--paper); } .shut svg { width: 16px; height: 16px; } .shut:last-child { margin-right: -6px; }
    .main { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .tabs { display: flex; gap: 2px; margin: 10px 12px 0; padding: 2px; border-radius: 8px; background: var(--canvas); box-shadow: inset 0 0 0 1px var(--hair); }
    .tabs button { flex: 1; height: 28px; border: 0; border-radius: 6px; background: none; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; transition: background .2s, color .2s; }
    .tabs button[aria-pressed="true"] { background: var(--raised); color: var(--paper); }
    .tabs button b { font-weight: 500; font-family: "Omni Mono", "JetBrains Mono", ui-monospace, monospace; font-size: 12px; margin-left: 6px; color: inherit; opacity: .8; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px 4px; }
    .bar label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .body { overflow: auto; overscroll-behavior: contain; padding: 8px 6px 10px; flex: 1; min-height: 120px; }
    @media (max-height: 560px) { .foot { display: none; } .p { bottom: 72px; max-height: calc(100vh - 84px); } }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; padding: 0 6px; }
    .cell { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--canvas); box-shadow: inset 0 0 0 1px var(--hair); cursor: pointer;
      transition: box-shadow .2s, transform .15s var(--out); }
    .cell:hover { box-shadow: inset 0 0 0 1px #696a68; transform: translateY(-1px); }
    .cell img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .cell.sel { box-shadow: inset 0 0 0 2px var(--bone); }
    .cell .dim { position: absolute; left: 4px; bottom: 4px; padding: 0 5px; border-radius: 4px; background: rgba(7,9,11,.82); color: var(--paper); font: 12px/18px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; }
    .cell .ck { position: absolute; top: 6px; left: 6px; width: 18px; height: 18px; border-radius: 5px; background: rgba(7,9,11,.7); box-shadow: inset 0 0 0 1px #696a68; transition: background .15s; }
    .cell.sel .ck { background: var(--bone); box-shadow: none; }
    .cell.sel .ck::after { content: ""; position: absolute; left: 6px; top: 2px; width: 5px; height: 10px; border: solid var(--canvas); border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .row { display: grid; gap: 6px; padding: 10px; border-radius: 8px; transition: background .2s; }
    .row:hover { background: var(--raised); }
    .row + .row { box-shadow: 0 -1px 0 var(--hair); } .row:hover, .row:hover + .row { box-shadow: none; }
    .row .t { color: var(--paper); font-weight: 500; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .row .meta { color: var(--body); font: 12px/1.5 "Omni Mono", "JetBrains Mono", ui-monospace, monospace; }
    .row .u { display: flex; min-width: 0; font: 12px/1.5 "Omni Mono", "JetBrains Mono", ui-monospace, monospace; color: var(--muted); white-space: nowrap; }
    .row .u .a { flex: 0 100 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; } .row .u .z { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; color: var(--body); }
    .row .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 2px; }
    .row.m { grid-template-columns: 128px minmax(0, 1fr); gap: 12px; align-items: start; }
    .row .info { display: grid; gap: 4px; min-width: 0; }
    .th { position: relative; display: block; width: 128px; aspect-ratio: 16 / 9; padding: 0; border: 0; border-radius: 6px; overflow: hidden; background: #000; box-shadow: inset 0 0 0 1px var(--hair); font: inherit; }
    button.th { cursor: pointer; }
    .th video { width: 100%; height: 100%; object-fit: contain; display: block; }
    .th:empty::after, .th.none::after { content: attr(data-note); position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 12px; text-align: center;
      background: radial-gradient(circle, rgba(233,225,220,.07) 0 1px, transparent 1.5px) 0 0 / 8px 8px; }
    .th.none video { display: none; }
    button.b { height: 32px; padding: 0 12px; border: 0; border-radius: 8px; background: none; color: var(--paper); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
      box-shadow: inset 0 0 0 1px var(--edge); transition: box-shadow .2s, transform .1s; }
    button.b:hover { box-shadow: inset 0 0 0 1px #696a68; } button.b:active { transform: scale(.97); } button.b:disabled { opacity: .4; cursor: default; transform: none; }
    button.pri { background: var(--bone); color: var(--canvas); box-shadow: 0 1px 3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.5); }
    button.pri:hover { box-shadow: 0 1px 3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.5), 0 0 0 3px rgba(233,225,220,.12); }
    select { height: 32px; padding: 0 8px; border: 0; border-radius: 8px; background: var(--canvas); color: var(--paper); font: inherit; font-size: 13px; box-shadow: inset 0 0 0 1px var(--edge); cursor: pointer; }
    input[type=number] { width: 64px; height: 28px; padding: 0 8px; border: 0; border-radius: 8px; background: var(--canvas); color: var(--paper); font: inherit; font-size: 13px; box-shadow: inset 0 0 0 1px var(--edge); }
    input[type=checkbox] { accent-color: var(--bone); }
    /* progress, in the ERP Dock's halftone: a dot-matrix track, bone dots for what's done, and while it runs a band of white
       dots sweeping along it */
    .prog { position: relative; height: 9px; margin-top: 4px; overflow: hidden; background: radial-gradient(circle, rgba(233,225,220,.13) 0 .8px, transparent 1.1px) 0 0 / 4px 9px; }
    .prog i { position: absolute; inset: 0 auto 0 0; width: 0; background: radial-gradient(circle, var(--bone) 0 .9px, transparent 1.2px) 0 0 / 4px 9px; transition: width .5s var(--out); }
    .prog.err i { background-image: radial-gradient(circle, var(--red) 0 .9px, transparent 1.2px); }
    .prog.on::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle, #fff 0 1.4px, transparent 1.8px) 0 0 / 4px 9px;
      -webkit-mask: linear-gradient(90deg, transparent calc(var(--od-p) - 18%), #000 calc(var(--od-p) - 4%), transparent var(--od-p));
      mask: linear-gradient(90deg, transparent calc(var(--od-p) - 18%), #000 calc(var(--od-p) - 4%), transparent var(--od-p)); animation: od-sweep 1.6s var(--swap) infinite; }
    @keyframes od-sweep { from { --od-p: 0%; } to { --od-p: 122%; } }
    @media (prefers-reduced-motion: reduce) { .prog.on::after { animation: none; display: none; } }
    .msg { font-size: 12px; color: var(--muted); } .msg.err { color: var(--red); } .msg.ok { color: var(--green); }
    .empty { display: grid; justify-items: center; gap: 12px; margin: 8px 10px; padding: 28px 12px; border-radius: 8px; text-align: center; color: var(--body); font-size: 13px;
      background: radial-gradient(circle, rgba(233,225,220,.06) 0 1px, transparent 1.5px) 0 0 / 8px 8px; box-shadow: inset 0 0 0 1px var(--hair); }
    .foot { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--muted); }
    .foot .hints { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-right: auto; } .foot .fmsg:empty { display: none; } .foot .fmsg { flex-basis: 100%; }
    kbd { font: 11px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; padding: 1px 5px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--edge); color: var(--body); }
    button:focus-visible, select:focus-visible, input:focus-visible, .cell:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
    .empty p { margin: 0; }
    /* the button under a video on the page */
    .pill { position: fixed; z-index: 2147483645; display: flex; align-items: center; height: 34px; padding: 0 4px 0 2px; border-radius: 9px; background: var(--card); color: var(--paper);
      box-shadow: inset 0 0 0 1px var(--edge), 0 10px 24px rgba(0,0,0,.35), 0 2px 4px rgba(0,0,0,.3); animation: pill-in .18s var(--out) both; }
    .pill[hidden] { display: none; }
    @keyframes pill-in { from { opacity: 0; transform: translateY(-4px); } }
    .pill button { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px 0 6px; border: 0; border-radius: 7px; background: none; color: inherit; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
    .pill button:hover { background: var(--raised); } .pill button svg { width: 22px; height: 22px; flex: none; }
    .pill small { color: var(--muted); font: 12px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; padding-right: 6px; }
    .trim { display: grid; gap: 8px; margin-top: 4px; padding: 10px; border-radius: 8px; background: var(--canvas); box-shadow: inset 0 0 0 1px var(--hair); }
    .trim .tr { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
    .trim .tf { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    .trim input { width: 92px; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: var(--card); color: var(--paper); font: 13px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; box-shadow: inset 0 0 0 1px var(--edge); }
    .trim input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--red); }
    button.b.sm { height: 30px; padding: 0 10px; font-size: 12px; }
    .trimline { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font: 12px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; color: var(--bone); }
    button.lnk { padding: 0; border: 0; background: none; color: var(--body); font: 12px "Omni Inter", Inter, ui-sans-serif, system-ui, sans-serif; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
    button.lnk:hover { color: var(--paper); }
    .row.flash { animation: flash 1.6s var(--out); }
    @keyframes flash { from { background: #262a2b; box-shadow: inset 0 0 0 1px var(--bone); } }
    @media (prefers-reduced-motion: reduce) { .pill, .row.flash { animation: none; } }
    .top { transition: box-shadow .2s; } .top:focus-within { box-shadow: inset 0 -2px 0 var(--blue); } .top input:focus-visible { outline: 0; }
    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .tabs button span { pointer-events: none; }
    /* one main action and a ▾ joined to it */
    .split { display: inline-flex; } .split button.b:first-child { border-radius: 8px 0 0 8px; } .split .caret { width: 30px; padding: 0; border-radius: 0 8px 8px 0; display: grid; place-items: center; margin-left: 1px; }
    .split .caret svg { width: 16px; height: 16px; } .split .caret[aria-expanded="true"] svg { transform: rotate(180deg); }
    .menu { position: absolute; z-index: 3; min-width: 220px; padding: 4px; border-radius: 10px; background: var(--raised); box-shadow: inset 0 0 0 1px var(--edge), 0 16px 32px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3);
      animation: menu-in .16s var(--out) both; }
    @keyframes menu-in { from { opacity: 0; transform: translateY(-4px); } }
    .mi { display: flex; width: 100%; align-items: center; gap: 12px; height: 34px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--paper); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .mi span { flex: 1; } .mi small { color: var(--muted); font: 11px "Omni Mono", "JetBrains Mono", ui-monospace, monospace; letter-spacing: .02em; }
    .mi:hover, .mi:focus-visible { background: #262a2b; outline: 0; }
    .menu .sep { height: 1px; margin: 4px 6px; background: var(--edge); }
    ::selection { background: rgba(233,225,220,.28); color: var(--paper); }
    .body { scrollbar-width: thin; scrollbar-color: var(--edge) transparent; }
    @media (pointer: coarse) { button.b, select, .mi { height: 40px; } .shut { width: 40px; height: 40px; } .tabs button { height: 36px; } .split .caret { width: 40px; } }
    @media (prefers-reduced-motion: reduce) { .fab:hover, .fab:active, .cell:hover, button.b:active { transform: none; } .fab svg, .prog i { transition: none; } .menu { animation: none; } }
  `;
  // the halftone wave animates a length, which only works on a registered property (and that can't be done inside a shadow root)
  try { CSS.registerProperty({ name: "--ht-w", syntax: "<length>", inherits: false, initialValue: "9000px" }); } catch {}
  try { CSS.registerProperty({ name: "--od-p", syntax: "<percentage>", inherits: false, initialValue: "0%" }); } catch {}
  const ICON = {
    down: '<svg class="open" viewBox="12 12 104 104" fill="currentColor"><g><circle cx="91.0" cy="26.8" r="1.1" fill-opacity="0.41"/><circle cx="98.2" cy="33.2" r="1.1" fill-opacity="0.46"/><circle cx="103.8" cy="41.0" r="1.3" fill-opacity="0.51"/><circle cx="107.7" cy="49.8" r="1.5" fill-opacity="0.57"/><circle cx="109.7" cy="59.2" r="1.7" fill-opacity="0.64"/><circle cx="109.7" cy="68.8" r="2.0" fill-opacity="0.71"/><circle cx="107.7" cy="78.2" r="2.3" fill-opacity="0.78"/><circle cx="103.8" cy="87.0" r="2.6" fill-opacity="0.84"/><circle cx="98.2" cy="94.8" r="2.9" fill-opacity="0.89"/><circle cx="91.0" cy="101.2" r="3.2" fill-opacity="0.94"/><circle cx="82.7" cy="106.0" r="3.4" fill-opacity="0.97"/><circle cx="73.6" cy="109.0" r="3.6" fill-opacity="0.99"/><circle cx="64.0" cy="110.0" r="3.6" fill-opacity="1.00"/><circle cx="54.4" cy="109.0" r="3.6" fill-opacity="0.99"/><circle cx="45.3" cy="106.0" r="3.4" fill-opacity="0.97"/><circle cx="37.0" cy="101.2" r="3.2" fill-opacity="0.94"/><circle cx="29.8" cy="94.8" r="2.9" fill-opacity="0.89"/><circle cx="24.2" cy="87.0" r="2.6" fill-opacity="0.84"/><circle cx="20.3" cy="78.2" r="2.3" fill-opacity="0.78"/><circle cx="18.3" cy="68.8" r="2.0" fill-opacity="0.71"/><circle cx="18.3" cy="59.2" r="1.7" fill-opacity="0.64"/><circle cx="20.3" cy="49.8" r="1.5" fill-opacity="0.57"/><circle cx="24.2" cy="41.0" r="1.3" fill-opacity="0.51"/><circle cx="29.8" cy="33.2" r="1.1" fill-opacity="0.46"/><circle cx="37.0" cy="26.8" r="1.1" fill-opacity="0.41"/><circle cx="87.1" cy="33.9" r="0.9" fill-opacity="0.42"/><circle cx="94.1" cy="40.9" r="1.0" fill-opacity="0.48"/><circle cx="99.1" cy="49.5" r="1.2" fill-opacity="0.55"/><circle cx="101.7" cy="59.0" r="1.4" fill-opacity="0.63"/><circle cx="101.7" cy="69.0" r="1.7" fill-opacity="0.72"/><circle cx="99.1" cy="78.5" r="2.1" fill-opacity="0.80"/><circle cx="94.1" cy="87.1" r="2.4" fill-opacity="0.87"/><circle cx="87.1" cy="94.1" r="2.7" fill-opacity="0.93"/><circle cx="78.5" cy="99.1" r="2.9" fill-opacity="0.98"/><circle cx="69.0" cy="101.7" r="3.0" fill-opacity="1.00"/><circle cx="59.0" cy="101.7" r="3.0" fill-opacity="1.00"/><circle cx="49.5" cy="99.1" r="2.9" fill-opacity="0.98"/><circle cx="40.9" cy="94.1" r="2.7" fill-opacity="0.93"/><circle cx="33.9" cy="87.1" r="2.4" fill-opacity="0.87"/><circle cx="28.9" cy="78.5" r="2.1" fill-opacity="0.80"/><circle cx="26.3" cy="69.0" r="1.7" fill-opacity="0.72"/><circle cx="26.3" cy="59.0" r="1.4" fill-opacity="0.63"/><circle cx="28.9" cy="49.5" r="1.2" fill-opacity="0.55"/><circle cx="33.9" cy="40.9" r="1.0" fill-opacity="0.48"/><circle cx="40.9" cy="33.9" r="0.9" fill-opacity="0.42"/></g><path d="M64 41v34M51 63l13 13 13-13M49 88h30" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>', // the logo: the download arrow in its halftone ring
    x: '<svg class="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>',
    again: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  };
  let host, root, fab, panel, main, foot, live, menu = null, pendingDraw = false, opener = null, gridFocus = "", query = "";
  let tab = store.get("tab", "video"), minSize = store.get("min", 150), barMsg = { text: "", tone: "" };
  const picked = new Set(), jobs = new Map(); // url → { ctl, frac, text, err, done, at }
  const rows = new Map(), cells = new Map(); // each row and image tile is made once and kept, so nothing reloads on a redraw
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (t, run, cls = "b") => { const b = mk("button", cls, t); b.type = "button"; b.onclick = run; return b; };
  // a "video" file that turned out to have no picture (DASH sites name their sound files .mp4 / .m4s) is a sound track
  const soundOnly = (it) => it.kind === "video" && !!it.meta?.loaded && !it.meta.w;
  // look inside every video file once (metadata only, one at a time), so sound tracks move to the Audio tab before you see them
  let probing = Promise.resolve();
  function probeAll() {
    for (const it of found.values()) if (it.kind === "video" && !it.meta && !it.probing && !partOf.has(it.url) && /^https?:/.test(it.url)) {
      it.probing = true; probing = probing.then(() => probe(it)).then(() => { if (soundOnly(it)) onChange(); });
    }
  }
  const groups = () => {
    const g = { video: [], image: [], audio: [] };
    const q = fold(query);
    for (const it of found.values()) if (!partOf.has(it.url) && (!q || fold(`${it.url} ${it.title || ""}`).includes(q))) (it.kind === "image" ? g.image : it.kind === "audio" || soundOnly(it) ? g.audio : g.video).push(it);
    g.video.sort((a, b) => (b.kind === "yt") - (a.kind === "yt") || (b.kind === "hls") - (a.kind === "hls") || (b.kind === "video") - (a.kind === "video"));
    return g;
  };
  const fold = (t) => String(t || "").toLowerCase();
  // YouTube and other Google sites enforce Trusted Types: an HTML string set as innerHTML throws there, so the icons go
  // through a policy of the script's own (its strings are fixed, written here). Without Trusted Types it's a plain string.
  const trusted = (() => { try { return W.trustedTypes?.createPolicy("omni-downloader", { createHTML: (s) => s }); } catch { return null; } })();
  const svg = (name) => {
    const t = document.createElement("template");
    try { t.innerHTML = trusted ? trusted.createHTML(ICON[name]) : ICON[name]; }
    catch { return document.createElement("span"); } // a page that allows no policy of ours: no icon, but everything else works
    const s = t.content.firstChild; s.setAttribute("aria-hidden", "true"); return s;
  };
  // the shortcut: Alt+Shift+D, since Alt+D is the browser's own "go to the address bar". Alt+D can be chosen in the menu.
  const altD = () => store.get("key", "alt+shift+d") === "alt+d";
  const keyNames = () => altD() ? ["Alt", "D"] : ["Alt", "Shift", "D"];

  // the panel's type: Inter and JetBrains Mono come bundled with the script (@resource) and are added from their bytes,
  // so no page makes a font request and no page's font rules (CSP) can block them. Without them, the system's fonts.
  let fontsOn = false;
  function loadFonts() {
    if (fontsOn || typeof GM_getResourceURL !== "function" || !document.fonts || typeof FontFace !== "function") return;
    fontsOn = true;
    for (const [name, res, weight] of [["Omni Inter", "inter", "100 900"], ["Omni Mono", "mono", "100 800"]]) {
      try {
        const add = (src) => { const f = new FontFace(name, src, { weight }); document.fonts.add(f); f.load().catch(() => {}); };
        const u = GM_getResourceURL(res, false);
        if (!u) continue;
        if (/^data:/.test(u)) { const b = atob(u.slice(u.indexOf(",") + 1)), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); add(a.buffer); }
        else fetch(u).then((r) => r.arrayBuffer()).then(add, () => {});
      } catch {}
    }
  }

  function mount() {
    if (host || !document.body) return;
    host = mk("div"); host.id = "omni-downloader"; root = host.attachShadow({ mode: "closed" });
    root.append(mk("style", null, css));
    fab = btn("", () => toggle(), "fab"); fab.title = `Omni Downloader (${keyNames().join("+")})`; fab.setAttribute("aria-expanded", "false");
    fab.onkeydown = (e) => { if (e.key === "Escape" && panel) { e.preventDefault(); toggle(); } };
    fab.append(svg("down"), svg("x"), mk("span", "n"));
    fab.lastChild.setAttribute("aria-hidden", "true");
    root.append(fab); document.documentElement.append(host); drawFab(); loadFonts();
  }
  function drawFab() {
    if (!fab) return;
    const n = groups(), media = n.video.length + n.audio.length, imgs = n.image.filter(big).length;
    fab.querySelector(".n").textContent = media ? String(media) : "";
    fab.setAttribute("aria-label", `Omni Downloader: ${media} video and audio, ${imgs} ${imgs === 1 ? "image" : "images"}`);
    fab.setAttribute("aria-expanded", String(!!panel && !panel.classList.contains("out")));
    fab.style.display = store.get("fab", true) || panel ? "" : "none";
  }
  let drawT = 0;
  onChange = () => { clearTimeout(drawT); drawT = setTimeout(() => { drawFab(); if (menu) pendingDraw = true; else draw(); }, 400); };
  // one place screen readers hear from: saves, Ghost, copies, errors
  function say(text) { if (!live || !text) return; live.textContent = ""; setTimeout(() => { if (live) live.textContent = text; }, 60); }
  // a failure in words a person can act on
  function friendly(e) {
    const m = String(e?.message || e || "It failed"), code = +(/HTTP (\d{3})/.exec(m)?.[1] || 0);
    if (code === 401 || code === 403) return `The site refused it (HTTP ${code}). Reload the page and try again, or send it to Ghost.`;
    if (code === 404 || code === 410) return `The file is gone (HTTP ${code}). Play the video again, then press Look again.`;
    if (code >= 500) return `The site's server failed (HTTP ${code}). Try again in a moment.`;
    if (/timed out/i.test(m)) return "It timed out. Try again, or send it to Ghost.";
    if (/network error|failed to fetch/i.test(m)) return "The connection failed. Check you're online, then try again.";
    return /[.!?]$/.test(m) ? m : `${m}.`;
  }

  function toggle() {
    mount(); if (!root) return;
    if (panel) {
      const p = panel, inside = p.contains(root.activeElement);
      closeMenu(); panel = null; main = null; foot = null; live = null; query = ""; p.classList.add("out"); drawFab();
      if (inside) { try { (opener?.isConnected && opener !== document.body ? opener : fab).focus({ preventScroll: true }); } catch {} }
      setTimeout(() => p.remove(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 230); return;
    }
    const was = document.activeElement; opener = was === host ? fab : was;
    try { scan(); } catch {}
    panel = mk("div", "p"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-labelledby", "od-h");
    const opened = panel, done = () => opened.classList.add("done"); // drops the dot mask once the wave has passed
    opened.addEventListener("animationend", done, { once: true }); setTimeout(done, 700); // (a background tab may never end the animation)
    const h = mk("h2", "sr", "Omni Downloader"); h.id = "od-h";
    live = mk("div", "sr"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite");
    // the filter bar, made once so typing in it isn't interrupted by redraws
    const top = mk("div", "top"), q = mk("input"); q.placeholder = "Filter by name or address…"; q.value = query; q.setAttribute("aria-label", "Filter"); q.dataset.k = "filter";
    q.oninput = () => { query = q.value; draw(); };
    q.onkeydown = (e) => {
      if (e.key === "Escape" && q.value) { e.preventDefault(); e.stopPropagation(); q.value = query = ""; draw(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); (main.querySelector(".body [data-k$=':main']") || main.querySelector(".body .cell[tabindex='0']") || main.querySelector(".bar button:not(:disabled), .body button"))?.focus(); }
    };
    const again = btn("", () => { try { scan(); } catch {} draw(); const g = groups(); say(`Looked again: ${g.video.length} video, ${g.image.filter(big).length} images, ${g.audio.length} audio.`); }, "shut");
    again.append(svg("again")); again.title = "Look again"; again.setAttribute("aria-label", "Look again"); again.dataset.k = "again";
    const shut = btn("", () => toggle(), "shut"); const xs = svg("x"); xs.classList.remove("x"); shut.append(xs); shut.title = "Close (Esc)"; shut.setAttribute("aria-label", "Close");
    const lens = svg("find"); top.append(lens, q, again, shut);
    main = mk("div", "main");
    foot = mk("div", "foot"); const hints = mk("span", "hints");
    // the page itself, for sites Ghost reads on its own (YouTube and Bilibili through yt-dlp and its own support)
    const page = btn("Page to Ghost", () => {
      page.disabled = true; setFoot("Sending the page…");
      ghostAdd(location.href, location.href).then(() => setFoot("Page sent to Ghost.", "ok", true), (e) => setFoot(e.message, "err", true)).finally(() => { page.disabled = false; });
    });
    page.title = "Send this page's address to Ghost Downloader (YouTube, Bilibili and others it reads itself)"; page.dataset.k = "page";
    foot.append(hints, page, mk("span", "msg fmsg"));
    panel.append(h, live, top, main, foot);
    // keys stay with the panel: Esc closes it, arrows move, and the page's own shortcuts (YouTube's space, k, j…) don't fire
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); if (menu) closeMenu(true); else toggle(); }
      else if (menu) menuKeys(e);
      else arrows(e);
    });
    for (const t of ["keydown", "keyup", "keypress"]) panel.addEventListener(t, (e) => e.stopPropagation());
    panel.addEventListener("pointerdown", (e) => { if (menu && !menu.contains(e.target) && e.target !== menu.anchor && !menu.anchor?.contains(e.target)) closeMenu(); });
    root.append(panel); draw(); drawFab();
    q.focus({ preventScroll: true });
  }
  const setFoot = (text, tone = "", announce = false) => { const m = foot?.querySelector(".fmsg"); if (m) { m.className = `msg fmsg ${tone}`; m.textContent = text; } if (announce) say(text); };

  function draw() {
    if (!panel) return;
    if (menu) { pendingDraw = true; return; }
    for (const it of found.values()) if (it.kind === "hls") hlsLoad(it);
    probeAll();
    // a redraw replaces the panel's insides: remember what had focus and where the list was scrolled, and put both back
    const a = root.activeElement, k = a && main.contains(a) ? a.dataset.k : null;
    const g = groups(), body = main.querySelector(".body"), keep = body ? body.scrollTop : 0;
    main.replaceChildren();
    const tabs = mk("div", "tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Kind of media");
    for (const [kk, t] of [["video", "Video"], ["image", "Images"], ["audio", "Audio"]]) {
      const n = kk === "image" ? g.image.filter(big).length : g[kk].length;
      const b = btn("", () => setTab(kk), ""); b.id = `od-tab-${kk}`; b.dataset.k = `tab:${kk}`;
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(kk === tab)); b.setAttribute("aria-controls", "od-body"); b.tabIndex = kk === tab ? 0 : -1;
      b.setAttribute("aria-label", `${t}, ${n} ${n === 1 ? "item" : "items"}`);
      const c = mk("b", null, String(n)); c.setAttribute("aria-hidden", "true"); b.append(mk("span", null, t), c); tabs.append(b);
    }
    main.append(tabs);
    const nb = mk("div", "body"); nb.id = "od-body"; nb.setAttribute("role", "tabpanel"); nb.setAttribute("aria-labelledby", `od-tab-${tab}`);
    if (tab === "image") drawImages(g.image, nb); else drawMedia(g[tab], nb);
    main.append(nb); nb.scrollTop = keep;
    // the footer's hints follow the tab
    const kb = (...ks) => { const s = mk("span"); ks.forEach((x, i) => { if (i < ks.length - 1) s.append(mk("kbd", null, x), " "); else s.append(x); }); return s; };
    foot?.querySelector(".hints").replaceChildren(...(tab === "image"
      ? [kb("Space", "select"), kb("Enter", "save"), kb("Esc", "close")]
      : [kb(...keyNames(), "open"), kb("↑", "↓", "move"), kb("Esc", "close")]));
    if (k) { const el = main.querySelector(`[data-k="${CSS.escape(k)}"]`); if (el && root.activeElement !== el) el.focus({ preventScroll: true }); }
    drawFab();
  }
  function setTab(k) { tab = k; store.set("tab", k); draw(); main.querySelector(`[data-k="tab:${k}"]`)?.focus(); }
  const big = (it) => it.kind !== "image" || !it.broken && (!it.w || (it.w >= minSize && it.h >= minSize));

  // ---------- moving with the keyboard ----------
  function arrows(e) {
    const a = root.activeElement; if (!a || !/^Arrow/.test(e.key)) return;
    if (a.getAttribute("role") === "tab") {
      if (e.key === "ArrowDown") { e.preventDefault(); (main.querySelector(".body [data-k$=':main']") || main.querySelector(".bar input, .bar button:not(:disabled)"))?.focus(); return; }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const order = ["video", "image", "audio"], i = order.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
      e.preventDefault(); setTab(order[(i + 3) % 3]); return;
    }
    if (a.classList.contains("cell")) {
      const all = [...main.querySelectorAll(".cell")], i = all.indexOf(a), cols = getComputedStyle(a.parentElement).gridTemplateColumns.split(" ").length || 1;
      const j = i + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key] || 0);
      e.preventDefault(); if (all[j]) all[j].focus(); else if (j < 0) main.querySelector(".bar button, .bar input")?.focus(); return;
    }
    const row = a.closest?.(".row");
    if (row && (e.key === "ArrowDown" || e.key === "ArrowUp") && a.tagName !== "SELECT") {
      const list = [...main.querySelectorAll(".row")], next = list[list.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      e.preventDefault();
      if (next) (next.querySelector("[data-k$=':main']") || next.querySelector("button, select"))?.focus();
      else if (e.key === "ArrowUp") panel.querySelector(".top input")?.focus();
    }
  }

  // ---------- the ▾ menu: one at a time, inside the panel ----------
  function openMenu(anchor, items) {
    if (menu && menu.anchor === anchor) return closeMenu(true);
    closeMenu();
    menu = mk("div", "menu"); menu.setAttribute("role", "menu"); menu.anchor = anchor;
    for (const x of items) {
      if (x.sep) { menu.append(mk("div", "sep")); continue; }
      const b = btn("", () => { closeMenu(true); x.run(); }, "mi"); b.tabIndex = -1;
      b.setAttribute("role", x.check == null ? "menuitem" : "menuitemcheckbox"); if (x.check != null) b.setAttribute("aria-checked", String(x.check));
      b.append(mk("span", null, x.label)); if (x.on) b.append(mk("small", null, "default")); if (x.check) b.append(mk("small", null, "on"));
      menu.append(b);
    }
    anchor.setAttribute("aria-expanded", "true");
    panel.append(menu);
    const pr = panel.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), mh = menu.offsetHeight, mw = menu.offsetWidth;
    let top = ar.bottom - pr.top + 4; if (top + mh > pr.height - 8) top = ar.top - pr.top - mh - 4;
    menu.style.top = `${Math.max(8, top)}px`; menu.style.left = `${Math.max(8, Math.min(ar.right - pr.left - mw, pr.width - mw - 8))}px`;
    menu.querySelector(".mi")?.focus();
  }
  function closeMenu(refocus) {
    if (!menu) return;
    const a = menu.anchor; menu.remove(); menu = null; a?.setAttribute("aria-expanded", "false");
    if (refocus && a?.isConnected) a.focus({ preventScroll: true });
    if (pendingDraw) { pendingDraw = false; draw(); }
  }
  function menuKeys(e) {
    const items = [...menu.querySelectorAll(".mi")], i = items.indexOf(root.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (go != null) { e.preventDefault(); items[(go + items.length) % items.length]?.focus(); }
    else if (e.key === "Tab") closeMenu();
  }
  // one main action and a ▾ for the rest; the main one is whichever you last picked from the menu
  function split(label, run, items, k, strong) {
    const w = mk("div", "split"), cls = strong ? "b pri" : "b";
    const a = btn(label, run, cls), c = btn("", (e) => openMenu(c, items), `${cls} caret`);
    a.dataset.k = `${k}:main`; c.dataset.k = `${k}:more`; c.title = "More"; c.setAttribute("aria-label", `More for ${label}`);
    c.setAttribute("aria-haspopup", "menu"); c.setAttribute("aria-expanded", "false"); c.append(svg("caret"));
    w.append(a, c); return w;
  }

  // ---------- Images ----------
  function drawImages(list, nb) {
    const shown = list.filter(big);
    main.append(drawBar(shown));
    if (!shown.length) {
      if (list.length && !query) return empty(nb, `No images of ${minSize}px or more.`, "Show every size", () => { minSize = 0; store.set("min", 0); draw(); });
      return empty(nb, "No images found yet.");
    }
    if (!shown.some((x) => x.url === gridFocus)) gridFocus = shown[0].url;
    const grid = mk("div", "grid");
    for (const it of shown) { const c = cellOf(it); c.tabIndex = it.url === gridFocus ? 0 : -1; grid.append(c); }
    nb.append(grid);
  }
  function cellOf(it) {
    let c = cells.get(it.url);
    if (!c) {
      c = mk("div", "cell"); c.dataset.k = `cell:${it.url}`; c.title = it.url; c.setAttribute("role", "checkbox");
      const im = mk("img"); im.alt = ""; im.loading = "lazy"; im.referrerPolicy = "no-referrer-when-downgrade"; im.src = it.url;
      const dim = mk("span", "dim", it.w ? `${it.w}×${it.h}` : ""); dim.setAttribute("aria-hidden", "true");
      im.onerror = () => { it.broken = true; onChange(); }; // a dead address isn't worth a tile
      im.onload = () => { if (!it.w) { it.w = im.naturalWidth; it.h = im.naturalHeight; dim.textContent = `${it.w}×${it.h}`; name(); } };
      const name = () => c.setAttribute("aria-label", `${fileName(it, "jpg")}${it.w ? `, ${it.w} by ${it.h}` : ""}`);
      const ck = mk("span", "ck"); ck.setAttribute("aria-hidden", "true");
      c.append(im, ck, dim); name();
      c.onclick = () => flip(it, c);
      c.onfocus = () => { gridFocus = it.url; for (const x of main?.querySelectorAll(".cell") || []) x.tabIndex = x === c ? 0 : -1; };
      c.onkeydown = (e) => { if (e.key === " ") { e.preventDefault(); flip(it, c); } else if (e.key === "Enter") { e.preventDefault(); saveOne(it); } };
      c.ondblclick = (e) => { e.stopPropagation(); saveOne(it); };
      cells.set(it.url, c);
    }
    c.classList.toggle("sel", picked.has(it.url)); c.setAttribute("aria-checked", String(picked.has(it.url)));
    return c;
  }
  // ticking a tile changes it and the bar, nothing else, so focus and the grid stay where they are
  function flip(it, c) {
    picked.has(it.url) ? picked.delete(it.url) : picked.add(it.url);
    c.classList.toggle("sel", picked.has(it.url)); c.setAttribute("aria-checked", String(picked.has(it.url)));
    const shown = groups().image.filter(big), old = main?.querySelector(".bar");
    if (old) { const a = root.activeElement, k = a && old.contains(a) ? a.dataset.k : null, nw = drawBar(shown); old.replaceWith(nw); if (k) nw.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(); }
  }
  function saveOne(it) {
    setBar(`Saving ${fileName(it, "jpg")}…`);
    lastSaved = ""; saveDirect(it).then(() => setBar(`Saved ${lastSaved || fileName(it, "jpg")}.`, "ok", true), (e) => setBar(friendly(e), "err", true));
  }
  function drawBar(shown) {
    const bar = mk("div", "bar"), sel = shown.filter((it) => picked.has(it.url)), n = sel.length;
    const min = mk("input"); min.type = "number"; min.min = "0"; min.step = "50"; min.value = minSize; min.dataset.k = "bar:min"; min.setAttribute("aria-label", "Smallest size in pixels");
    min.onchange = () => { minSize = Math.max(0, +min.value || 0); store.set("min", minSize); draw(); };
    const l = mk("label"); l.append("Smallest", min, "px"); bar.append(l);
    const all = btn(n === shown.length && n ? "Select none" : "Select all", () => {
      if (n === shown.length) shown.forEach((x) => picked.delete(x.url)); else shown.forEach((x) => picked.add(x.url));
      for (const it of shown) cellOf(it);
      const old = main.querySelector(".bar"), nw = drawBar(shown); old.replaceWith(nw); nw.querySelector("[data-k='bar:all']")?.focus();
      say(n === shown.length ? "None selected." : `${shown.length} selected.`);
    }); all.dataset.k = "bar:all"; all.disabled = !shown.length;
    const via = store.get("viaImg", "zip"), sendable = sel.filter((x) => /^https?:/.test(x.url));
    const act = { zip: () => saveZip(sel), each: () => saveEach(sel), ghost: () => ghostEach(sendable) };
    const pick = (v) => () => { store.set("viaImg", v); act[v](); };
    const label = n ? { zip: `ZIP ${n}`, each: `Save ${n}`, ghost: `Ghost ${n}` }[via] : { zip: "ZIP", each: "Save", ghost: "Ghost" }[via];
    const sp = split(label, act[via], [
      { label: "Save as one ZIP", run: pick("zip"), on: via === "zip" },
      { label: "Save one by one", run: pick("each"), on: via === "each" },
      { label: "Send to Ghost Downloader", run: pick("ghost"), on: via === "ghost" },
    ], "bar:go", true);
    for (const b of sp.children) b.disabled = !n;
    const msg = mk("span", `msg ${barMsg.tone}`, barMsg.text);
    bar.append(all, sp, msg);
    return bar;
  }
  const setBar = (text, tone = "", announce = false) => { barMsg = { text, tone }; const m = main?.querySelector(".bar .msg"); if (m) { m.className = `msg ${tone}`; m.textContent = text; } if (announce) say(text); };
  async function saveEach(list) {
    let ok = 0, bad = 0, why = "";
    for (const it of list) { setBar(`Saving ${ok + bad + 1} of ${list.length}…`); try { await saveDirect(it); ok++; } catch (e) { bad++; why = friendly(e); } }
    setBar(bad ? `${ok} saved, ${bad} failed. ${why}` : `${ok} saved.`, bad ? "err" : "ok", true);
  }
  async function saveZip(list) {
    const ff = W.fflate || window.fflate || (typeof fflate !== "undefined" ? fflate : null);
    if (!ff?.zip) return saveEach(list);
    const files = {}, names = new Set(); let bad = 0, n = 0;
    await Promise.all(list.map(async (it) => {
      try {
        const buf = await getRetry(it.url, "buffer", it.referer);
        let name = fileName(it, "jpg"), i = 1; while (names.has(name)) name = name.replace(/(\.\w+)?$/, ` (${++i})$1`); names.add(name);
        files[name] = [new Uint8Array(buf), { level: 0 }]; // images are compressed already
      } catch { bad++; }
      setBar(`Fetching ${++n} of ${list.length}…`);
    }));
    ff.zip(files, (err, data) => {
      if (err) return setBar("Couldn't make the ZIP. Try Save one by one from the ▾ menu.", "err", true);
      const name = `${clean(document.title)} images.zip`;
      saveBlob(new Blob([data], { type: "application/zip" }), name);
      setBar(`${Object.keys(files).length} in ${name}${bad ? `; ${bad} couldn't be fetched` : ""}.`, bad ? "err" : "ok", true);
    });
  }
  function empty(nb, text, action, run) {
    const e = mk("div", "empty");
    if (query) {
      e.append(mk("p", null, `Nothing matches “${query}”.`), btn("Clear the filter", () => { query = ""; const q = panel.querySelector(".top input"); q.value = ""; draw(); q.focus(); }));
    } else { e.append(mk("p", null, text)); if (action) e.append(btn(action, run)); }
    nb.append(e);
  }

  // ---------- Video and Audio rows ----------
  function drawMedia(list, nb) {
    if (!list.length) return empty(nb, tab === "video" ? "No video found yet. Press play, then Look again: streams show up once the player loads them." : "No audio found yet.");
    list.forEach((it, i) => nb.append(rowOf(it, i === 0)));
  }
  const canGhost = (it) => /^https?:/.test(it.url);
  // a row is rebuilt only when something it shows changes; names and sizes that arrive later are written in place
  function rowOf(it, first) {
    const job = jobs.get(it.url), via = store.get("via", "save");
    const sig = JSON.stringify([first, via, it.kind, soundOnly(it), !!it.variants, it.variants?.length, it.pick, !!it.asTs, it.err, it.drm, it.dur,
      job && [job.at, !!job.done, job.err], it.status?.at, it.trim, it.trimOpen, it.frag]);
    const had = rows.get(it.url);
    if (had && had.sig === sig) return had.el;
    const row = mk("div", "row m"), info = mk("div", "info");
    row.append(thumb(it), info); sizeLoad(it);
    const name = mk("div", "t", rowName(it)), meta = mk("div", "meta", rowMeta(it));
    it.rowEls = { name, meta }; info.append(name, meta, urlLine(it.url));
    const note = (t, tone = "") => info.append(mk("div", `msg ${tone}`, t));
    if (soundOnly(it)) note("Saving its video joins this sound in; save it here for the sound alone.");
    const acts = mk("div", "acts"), running = job && !job.done && !job.err, k = `row:${it.url}`;
    const copies = [
      { label: "Copy address", run: () => { copy(it.url); status(it, "Address copied.", "ok"); } },
      ...(it.kind === "yt" ? [] : [{ label: it.trim ? "Copy ffmpeg command (exact cut)" : "Copy ffmpeg command", run: () => { copy(ffmpegCmd(it)); status(it, it.trim ? "ffmpeg command copied: it cuts to the exact frame." : "ffmpeg command copied.", "ok"); } }]),
    ];
    const ghostOnly = (why) => { note(why); acts.append(split("Ghost", () => sendGhost(it), copies, k, first)); };
    if (it.kind === "yt") ghostOnly("YouTube locks its streams: Ghost saves it with yt-dlp.");
    else if (it.kind === "dash") ghostOnly("DASH isn't saved in the browser: Ghost saves it, or copy the ffmpeg command.");
    else if (it.kind === "hls" && it.err) note(`The playlist couldn't be read. ${friendly(it.err)}`, "err");
    else if (it.kind === "hls" && !it.variants) note("Reading the playlist…");
    else if (it.drm) { note(`DRM-protected (${it.drm}): it can't be saved, here or in Ghost.`, "err"); acts.append(split("Copy address", copies[0].run, copies.slice(1), k, false)); }
    else {
      if (it.kind === "hls") {
        const s = mk("select"); s.setAttribute("aria-label", "Quality"); s.dataset.k = `${k}:q`;
        // a stream's size is only known by fetching it: estimate it from the quality's bitrate and the length
        const mbps = (v) => v.bw ? ` · ${(v.bw / 1e6).toFixed(1)} Mb/s${it.dur ? ` · ≈ ${bytes(v.bw * it.dur / 8)}` : ""}` : "";
        it.variants.forEach((v, i) => s.append(new Option(v.res ? `${v.res.split("x")[1]}p${mbps(v)}` : v.url === it.url ? it.info || "Single quality"
          : v.codecs && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs) ? `Sound only${mbps(v)}` : `Quality ${i + 1}${mbps(v)}`, String(i), false, i === (it.pick || 0))));
        s.onchange = () => { it.pick = +s.value; draw(); }; s.disabled = !!running;
        if (it.variants.length > 1 || !it.info) acts.append(s); else note(it.info);
        const v = it.variants[it.pick || 0], est = v?.bw && it.dur ? v.bw * (it.trim ? it.trim.end - it.trim.start : it.dur) / 8 : 0;
        if (est > 1.5e9) note(it.trim ? `About ${bytes(est)}: the browser holds all of it in memory while saving. A shorter trim, or a lower quality, is safer.`
          : `About ${bytes(est)}: the browser holds all of it in memory while saving. Ghost is safer for one this big.`);
        if (v?.audio && it.audioTracks?.some((a) => a.group === v.audio)) note("Its sound is a separate track: save that from the Audio tab.");
      }
      const save = () => { store.set("via", "save"); it.kind === "hls" ? runHls(it) : runDirect(it); };
      const ghost = () => { store.set("via", "ghost"); sendGhost(it); };
      const extra = [
        ...(trimmable(it) ? [{ sep: true }, { label: it.trim ? "Change the trim…" : "Trim before saving…", run: () => openTrim(it) }] : []),
        ...(it.kind === "hls" ? [{ sep: true }, { label: "Keep as .ts (no conversion)", check: !!it.asTs, run: () => { it.asTs = !it.asTs; draw(); say(it.asTs ? "Will keep .ts." : "Will convert to MP4."); } }] : []),
      ];
      if (running) { const stop = btn("Stop", () => job.ctl.abort(), "b"); stop.dataset.k = `${k}:main`; acts.append(stop); }
      else if (!canGhost(it)) acts.append(split("Save", save, [...copies, ...extra], k, first));
      else {
        // Ghost can't be told to fetch part of a video, so while a trim is set the main button saves in the browser
        const g = via === "ghost" && !it.trim;
        acts.append(split(g ? "Ghost" : it.trim ? "Save part" : "Save", g ? ghost : save,
          [{ label: it.trim ? "Save the trimmed part" : "Save in the browser", run: save, on: !g }, { label: it.trim ? "Send the whole video to Ghost (it can't trim)" : "Send to Ghost Downloader", run: ghost, on: g },
            { sep: true }, ...copies, ...extra], k, first));
      }
    }
    info.append(acts);
    if (it.trimOpen) info.append(trimEditor(it));
    else if (it.trim) {
      const t = mk("div", "trimline"); t.append(mk("span", null, `Trimmed ${hms(it.trim.start)} – ${hms(it.trim.end)}${trimEstimate(it)}`));
      const ch = btn("Change", () => openTrim(it), "lnk"); ch.dataset.k = `${k}:trim`; const cl = btn("Clear", () => { it.trim = null; draw(); say("Trim cleared: Save gets the whole video."); }, "lnk"); cl.dataset.k = `${k}:clear`;
      t.append(ch, cl); info.append(t);
    }
    // one status line: the latest of the save and the last Ghost send or copy
    const showJob = job && (running || !it.status || job.at >= it.status.at);
    if (job) {
      const pr = mk("div", "prog" + (job.err ? " err" : job.done ? "" : " on")), bar = mk("i"); bar.style.width = `${Math.round((job.frac || 0) * 100)}%`; pr.append(bar);
      pr.setAttribute("aria-hidden", "true"); info.append(pr); job.bar = bar;
    }
    const line = mk("div", "msg"); info.append(line);
    if (showJob) { line.className = "msg" + (job.err ? " err" : job.done && !job.warn ? " ok" : ""); line.textContent = job.err || job.text || ""; job.line = line; }
    else if (it.status) { line.className = `msg ${it.status.tone}`; line.textContent = it.status.text; }
    rows.set(it.url, { el: row, sig });
    return row;
  }
  function status(it, text, tone = "", quiet) { it.status = { text, tone, at: Date.now() }; if (!quiet) say(text); draw(); }
  function sendGhost(it) {
    status(it, "Sending to Ghost…", "", true);
    ghostSend(it).then(() => status(it, "Sent to Ghost Downloader.", "ok"), (e) => status(it, e.message, "err"));
  }
  // ---------- the trim editor ----------
  const trimmable = (it) => (it.kind === "hls" || it.hlsAudio || it.kind === "video") && /^https?:/.test(it.url);
  const lengthOf = (it) => it.kind === "hls" ? it.dur : it.meta?.d || it.dur || 0;
  function trimEstimate(it) {
    const t = it.trim, len = t.end - t.start, v = it.variants?.[it.pick || 0], all = lengthOf(it);
    const size = v?.bw ? v.bw * len / 8 : it.size && all ? it.size * len / all : 0;
    return ` · ${hms(len)}${size ? ` · ≈ ${bytes(size)}` : ""}`;
  }
  function ffmpegCmd(it) {
    const out = `${fileName(it, "mp4").replace(/\.\w+$/, "")}${it.trim ? ` ${trimName(it.trim)}` : ""}.mp4`, src = it.kind === "hls" && it.variants?.length ? it.variants[it.pick || 0].url : it.url;
    const head = `ffmpeg -headers "Referer: ${it.referer || location.href}\\r\\n"`;
    // with a trim: seek before reading (fast), then re-encode so the cut lands on the exact frame
    return it.trim ? `${head} -ss ${it.trim.start} -to ${it.trim.end} -i "${src}" -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k "${out}"` : `${head} -i "${src}" -c copy "${out}"`;
  }
  // the page's player for an item: the one Omni matches to it, else the one playing, else the biggest on screen
  function playerFor(it) {
    const vs = [...document.querySelectorAll("video, audio")].filter((v) => v.duration);
    return vs.find((v) => itemFor(v) === it) || vs.find((v) => !v.paused) || vs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
  }
  function openTrim(it) {
    it.trimOpen = true; it.trimDraft = { start: it.trim?.start ?? 0, end: it.trim?.end ?? (lengthOf(it) || 60) };
    if (it.kind === "video" && !it.frag) fragKind(it).then((k) => { it.frag = k; draw(); });
    draw(); main.querySelector(`[data-k="${CSS.escape(`row:${it.url}:start`)}"]`)?.focus();
  }
  function trimEditor(it) {
    const k = `row:${it.url}`, d = it.trimDraft, box = mk("div", "trim"); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Trim before saving");
    const err = mk("div", "msg err");
    const field = (label, key) => {
      const l = mk("label", "tf"), inp = mk("input"); inp.value = hms(d[key]); inp.inputMode = "decimal"; inp.dataset.k = `${k}:${key}`; inp.setAttribute("aria-label", `${label}, hours:minutes:seconds`);
      inp.onchange = () => { const v = parseTime(inp.value); if (isNaN(v)) { inp.setAttribute("aria-invalid", "true"); err.textContent = `${label}: write it like 1:02:10 or 62:10.`; return; } inp.removeAttribute("aria-invalid"); d[key] = v; err.textContent = ""; };
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.onchange(); apply(); } };
      const now = btn("Now", () => {
        const pl = playerFor(it); if (!pl) { err.textContent = "No player on the page to read the time from: type it instead."; return; }
        d[key] = pl.currentTime; inp.value = hms(pl.currentTime); err.textContent = ""; say(`${label} set to ${hms(pl.currentTime)}.`);
      }, "b sm"); now.dataset.k = `${k}:${key}:now`; now.title = "Use the page's player's current time"; now.setAttribute("aria-label", `${label}: use the player's current time`);
      l.append(mk("span", null, label), inp, now); return l;
    };
    const apply = () => {
      const all = lengthOf(it), end = all ? Math.min(d.end, all) : d.end;
      if (!(end > d.start + 0.5)) { err.textContent = "The end has to come after the start."; return; }
      it.trim = { start: d.start, end }; it.trimOpen = false; draw();
      say(`Trimmed to ${hms(d.start)} – ${hms(end)}. Save gets only that part.`);
      main.querySelector(`[data-k="${CSS.escape(`${k}:main`)}"]`)?.focus();
    };
    const done = btn("Use this stretch", apply, "b pri sm"); done.dataset.k = `${k}:apply`;
    const cancel = btn("Cancel", () => { it.trimOpen = false; draw(); main.querySelector(`[data-k="${CSS.escape(`${k}:main`)}"]`)?.focus(); }, "b sm"); cancel.dataset.k = `${k}:cancel`;
    const row = mk("div", "tr"); row.append(field("Start", "start"), field("End", "end"));
    const btns = mk("div", "tr"); btns.append(done, cancel);
    const note = it.kind === "video" ? mk("div", "msg", it.frag === "plain" ? "This is a plain MP4: it can't be cut in the browser, so Save gets the whole file. Copy the ffmpeg command for an exact cut."
      : it.frag === "frag" ? "Cut at the nearest fragment edges, a few seconds either side." : "Checking whether this file can be cut here…")
      : mk("div", "msg", "Only the parts inside this stretch are downloaded. The cut lands on part edges, a few seconds either side.");
    box.append(row, note, btns, err); return box;
  }
  function rowName(it) {
    if (it.kind === "yt" || it.kind === "hls" || it.kind === "dash" || it.hlsAudio || BILI.test(it.url)) return it.title || document.title || "Stream";
    return fileName(it, it.kind === "audio" ? "mp3" : "mp4");
  }
  // where it came from, cut in the middle so the file name at the end stays in view (the whole address is in the tooltip)
  function urlLine(url) {
    const u = mk("div", "u"); u.title = url;
    let head = url, tail = "";
    try { const x = new URL(url), p = x.pathname, i = p.lastIndexOf("/"); head = x.host + p.slice(0, i + 1); tail = decodeURIComponent(p.slice(i + 1)) + (x.search ? "?…" : ""); } catch {}
    u.append(mk("span", "a", head), mk("span", "z", tail)); return u;
  }

  // ---------- thumbnails ----------
  // a file plays its own first frame (metadata only, so little is loaded), and only once its row is scrolled into view;
  // a stream gets one built from its first part at the lowest quality. Each is made once and kept. Click to play / pause.
  const clock = (d) => !isFinite(d) || !d ? "" : `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}`;
  // a file's size without downloading it: ask for its first byte and read the total from Content-Range (or the
  // Content-Length of a full answer, cut off at the headers)
  function headSize(url, referer) {
    return new Promise((resolve) => {
      let settled = false, req = null;
      const finish = (status, h) => {
        if (settled) return; settled = true; try { req?.abort(); } catch {}
        const cr = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(h || ""), cl = /content-length:\s*(\d+)/i.exec(h || "");
        resolve(cr ? +cr[1] : status === 200 && cl ? +cl[1] : null);
      };
      if (typeof GM_xmlhttpRequest === "function") {
        req = GM_xmlhttpRequest({ method: "GET", url, headers: { Range: "bytes=0-0", ...(referer ? { Referer: referer } : {}) }, responseType: "arraybuffer", timeout: 15000,
          onreadystatechange: (r) => { if (r.readyState >= 2 && r.responseHeaders) finish(r.status, r.responseHeaders); },
          onload: (r) => finish(r.status, r.responseHeaders), onerror: () => finish(0, ""), ontimeout: () => finish(0, "") });
        return;
      }
      fetch(url, { headers: { Range: "bytes=0-0" }, credentials: new URL(url, location.href).origin === location.origin ? "include" : "omit" })
        .then((r) => { finish(r.status, [...r.headers].map(([k, v]) => `${k}: ${v}`).join("\n")); r.body?.cancel().catch(() => {}); }, () => finish(0, ""));
    });
  }
  const bytes = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e7 ? `${Math.round(n / 1e6)} MB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
  function sizeLoad(it) {
    if (it.sizeP || !/^https?:/.test(it.url) || it.kind === "hls" || it.kind === "dash" || it.kind === "yt") return;
    it.sizeP = headSize(it.url, it.referer).then((n) => { it.size = n; retitle(it); for (const x of found.values()) if (x !== it && x.size && sameAsset(x, it)) retitle(x); });
  }
  const sameAsset = (a, b) => { const k = assetKey(a.url); return !!k && k === assetKey(b.url); };
  // a picture-only file is saved with its sound: count that too when the sound file is known
  function sizeText(it) {
    if (!it.size) return "";
    const pictureOnly = it.kind === "video" && it.meta?.loaded && it.meta.w;
    const sound = pictureOnly && [...found.values()].find((x) => x !== it && x.meta?.loaded && !x.meta.w && x.size && sameAsset(x, it));
    return sound ? `≈ ${bytes(it.size + sound.size)} with sound` : `≈ ${bytes(it.size)}`;
  }
  const retitle = (it) => { if (it.rowEls) { it.rowEls.name.textContent = rowName(it); it.rowEls.meta.textContent = rowMeta(it); } };
  function rowMeta(it) {
    const m = it.meta || {}, top = it.variants?.find((v) => v.res)?.res.split("x")[1];
    const w = it.kind === "hls" ? 0 : m.w || it.w, h = it.kind === "hls" ? 0 : m.h || it.h, d = it.kind === "hls" ? it.dur : m.d;
    const label = soundOnly(it) ? "Sound track" : it.kind === "yt" ? (it.shorts ? "YouTube Short" : "YouTube video") : { hls: "HLS stream", dash: "DASH stream", video: "Video file", audio: "Audio file" }[it.kind] || it.kind;
    return [label, it.frame && "in a frame", w && h && `${w}×${h}`, top && `up to ${top}p`, clock(d), sizeText(it)].filter(Boolean).join(" · ");
  }
  const seen = typeof IntersectionObserver === "function" ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { seen.unobserve(e.target); e.target.load?.(); } }, { rootMargin: "200px" }) : null;
  function thumb(it) {
    if (it.thumb) return it.thumb;
    const playable = it.kind === "video" || it.kind === "audio" || it.kind === "hls";
    const box = playable ? btn("", () => { const v = box.querySelector("video"); if (!v) return; if (v.paused) { v.play().catch(() => {}); box.setAttribute("aria-label", "Pause preview"); } else { v.pause(); box.setAttribute("aria-label", "Play preview"); } }, "th") : mk("div", "th");
    if (playable) { box.setAttribute("aria-label", "Play preview"); box.dataset.k = `th:${it.url}`; } else box.setAttribute("aria-hidden", "true");
    box.dataset.note = it.kind === "dash" ? "No preview" : "Loading…"; it.thumb = box;
    if (it.kind === "video" || it.kind === "audio") { box.load = () => preview(it, it.url); if (seen) seen.observe(box); else box.load(); }
    if (it.kind === "yt") { const im = mk("img"); im.alt = ""; im.src = `https://i.ytimg.com/vi/${it.ytId}/mqdefault.jpg`; im.style.cssText = "width:100%;height:100%;object-fit:cover"; box.append(im); }
    return box;
  }
  function preview(it, src) {
    const v = mk("video"); v.muted = true; v.playsInline = true; v.loop = true; v.preload = "metadata"; v.setAttribute("aria-hidden", "true"); v.tabIndex = -1;
    v.src = /^blob:/.test(src) || src.includes("#") ? src : `${src}#t=0.5`;
    v.onloadedmetadata = () => {
      if (/^blob:/.test(src) && isFinite(v.duration)) v.currentTime = Math.min(2, v.duration / 2); // streams often open on black
      it.meta = { ...(it.kind === "hls" ? {} : { d: v.duration }), w: v.videoWidth, h: v.videoHeight, loaded: true };
      retitle(it); for (const x of found.values()) if (x !== it && sameAsset(x, it)) retitle(x);
      if (!v.videoWidth) { it.thumb.classList.add("none"); it.thumb.dataset.note = "Sound only"; }
    };
    v.onerror = () => { it.thumb.classList.add("none"); it.thumb.dataset.note = "No preview"; };
    it.thumb.replaceChildren(v);
  }
  async function streamThumb(it) {
    try {
      const vids = it.variants.filter((v) => v.res || v.url === it.url), v = vids[vids.length - 1] || it.variants[0];
      const media = parseMedia(await getRetry(v.url, "text", it.referer), v.url);
      if (media.drm) { it.drm = media.drm; onChange(); throw 0; } // said on the row before you press Save, not after
      if (!media.segs.length) throw 0;
      const ctl = new AbortController(), seg = await decrypt(await getPart(media.segs[0], it.referer, ctl.signal), media.segs[0], it.referer, ctl.signal);
      const blob = media.map ? new Blob([await getPart(media.map, it.referer, ctl.signal), seg], { type: "video/mp4" }) : tsToMp4([seg]);
      if (!blob) throw 0;
      if (!it.dur) { it.dur = media.dur; onChange(); } // the qualities' sizes can be estimated now
      preview(it, URL.createObjectURL(blob));
    } catch { it.thumb?.classList.add("none"); if (it.thumb) it.thumb.dataset.note = "No preview"; }
  }

  // a stream's playlist, read once: its qualities (which then stop showing as rows of their own) and audio tracks
  function hlsLoad(it) {
    if (it.variants || it.loading || partOf.has(it.url)) return;
    it.loading = true;
    getRetry(it.url, "text", it.referer).then((t) => {
      const m = parseMaster(t, it.url);
      it.variants = m.variants.length ? m.variants : [{ url: it.url, res: "", bw: 0 }]; it.audioTracks = m.audio;
      for (const v of m.variants) if (v.url !== it.url) partOf.add(v.url);
      if (!m.variants.length) { const md = parseMedia(t, it.url); it.dur = md.dur; if (md.drm) it.drm = md.drm; it.info = `${md.segs.length} parts${md.dur ? ` · ${Math.round(md.dur / 60)} min` : ""}${md.live ? " · live (saves what's listed now)" : ""}`; }
      if (it.audioTracks?.length && !it.audioAdded) { it.audioAdded = true; for (const a of it.audioTracks) found.set(a.url, { url: a.url, kind: "audio", referer: it.referer, title: `${it.title || document.title} ${a.name}`, hlsAudio: true }); }
      thumb(it); streamThumb(it);
    }, (e) => { it.variants = []; it.err = e.message; }).finally(() => { it.loading = false; draw(); });
  }
  // a save shows a bar (parts done for a stream, MB of the total for a file), Stop, and the outcome with the file's name
  function startJob(it) {
    const ctl = new AbortController(), job = { ctl, frac: 0, text: "Starting…", at: Date.now() }; jobs.set(it.url, job); draw();
    return { job, ui: { signal: ctl.signal, progress: (f, t) => { job.frac = f; job.text = t; if (job.bar?.isConnected) job.bar.style.width = `${Math.round(f * 100)}%`; if (job.line?.isConnected) job.line.textContent = t; } } };
  }
  function endJob(it, job, e, text) {
    job.at = Date.now();
    if (e) job.err = e.name === "AbortError" ? "Stopped." : friendly(e); else { job.done = true; job.frac = 1; job.text = text; job.warn = /whole|without sound/i.test(text); }
    say(`${rowName(it)}: ${job.err || job.text}`); draw();
  }
  async function runHls(it) {
    const { job, ui } = startJob(it); lastSaved = "";
    try { const media = await saveHls(it, { ...it.variants[it.pick || 0], asTs: it.asTs, trim: it.trim }, ui); endJob(it, job, null, `Saved as ${lastSaved || "a video"}${media?.live ? " (a live stream: only what was listed so far)" : ""}.`); }
    catch (e) { endJob(it, job, e); }
  }
  async function runDirect(it) {
    const { job, ui } = startJob(it); lastSaved = "";
    try { const note = await saveDirect(it, ui); endJob(it, job, null, note ? `${note}.` : `Saved as ${lastSaved || rowName(it)}.`); }
    catch (e) { endJob(it, job, e); }
  }
  function copy(t) { try { GM_setClipboard(t, "text"); } catch { navigator.clipboard?.writeText(t).catch(() => {}); } }

  // ---------- Ghost Downloader ----------
  // Ghost Downloader 3, a desktop download manager, answers aria2's JSON-RPC on 127.0.0.1:16800 when its aria2 RPC
  // setting is on. "Ghost" hands it a file or stream with the page's Referer and User-Agent (and, for the page's own
  // files, its cookies), and Ghost downloads it in parallel pieces outside the browser: no size limit from memory, and
  // it resumes. A stream goes as the chosen quality's playlist (Ghost's M3U8 / DASH engines join it); Bilibili goes as
  // the page, which Ghost's own Bilibili support reads. Port and token are set from Tampermonkey's menu.
  const ghostCfg = () => ({ port: 16800, token: "", ...store.get("ghost", {}) });
  function ghostCall(method, params) {
    const { port, token } = ghostCfg(), url = `http://127.0.0.1:${port}/jsonrpc`;
    const data = JSON.stringify({ jsonrpc: "2.0", id: String(Date.now()), method, params: token ? [`token:${token}`, ...params] : params });
    const down = () => new Error("Ghost Downloader isn't answering: open it, and turn on aria2 RPC in its settings");
    const read = (text) => {
      let r; try { r = JSON.parse(text); } catch { throw down(); }
      if (r.error) throw new Error(/unauthorized/i.test(r.error.message) ? "Ghost wants its RPC token: set it from Tampermonkey's menu" : `Ghost: ${r.error.message}`);
      return r.result;
    };
    if (typeof GM_xmlhttpRequest !== "function") return fetch(url, { method: "POST", body: data }).then((r) => r.text(), () => { throw down(); }).then(read);
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: "POST", url, data, anonymous: true, timeout: 8000, headers: { "Content-Type": "application/json" },
      onload: (r) => { try { resolve(read(r.responseText)); } catch (e) { reject(e); } }, onerror: () => reject(down()), ontimeout: () => reject(down()) }));
  }
  // the browser's cookies for an address. Cloudflare's pass (cf_clearance) and most sign-ins are HttpOnly, which the page
  // can't read, so they come from Tampermonkey's GM_cookie (Tampermonkey → Settings → Security → "Allow scripts to access
  // cookies": All). Without it, the page's own readable cookies, for its own files only.
  function cookiesFor(url) {
    let own = ""; try { if (new URL(url).origin === location.origin) own = document.cookie; } catch {}
    const gc = typeof GM_cookie !== "undefined" ? GM_cookie : null;
    if (!gc?.list) return Promise.resolve(own);
    return new Promise((resolve) => {
      setTimeout(() => resolve(own), 3000);
      try { gc.list({ url }, (list, err) => resolve(!err && list?.length ? list.map((c) => `${c.name}=${c.value}`).join("; ") : own)); } catch { resolve(own); }
    });
  }
  async function ghostAdd(url, referer, name, withCookies = true) {
    const header = [`Referer: ${referer || location.href}`, `User-Agent: ${navigator.userAgent}`], cookie = withCookies ? await cookiesFor(url) : "";
    if (cookie) header.push(`Cookie: ${cookie}`);
    return ghostCall("aria2.addUri", [[url], name ? { header, out: name } : { header }]);
  }
  // what to hand over for one row: the chosen quality of a stream, the page for Bilibili, else the file
  function ghostSend(it) {
    if (it.kind === "yt") return ghostAdd(it.url, it.url, "", false); // yt-dlp names it; your Google sign-in stays in the browser
    if (BILI.test(it.url)) return ghostAdd(location.href, location.href);
    if (it.kind === "hls" && it.variants?.length) return ghostAdd(it.variants[it.pick || 0].url, it.referer, `${clean(it.title || document.title)}.mp4`);
    if (it.kind === "hls" || it.kind === "dash") return ghostAdd(it.url, it.referer, `${clean(it.title || document.title)}.mp4`);
    return ghostAdd(it.url, it.referer, fileName(it, it.kind === "image" ? "jpg" : it.kind === "audio" || soundOnly(it) ? "m4a" : "mp4"));
  }
  // picked images to Ghost: one failure doesn't stop the rest, unless Ghost itself isn't there
  async function ghostEach(list) {
    let ok = 0, bad = 0, why = "";
    for (const it of list) {
      setBar(`Sending ${ok + bad + 1} of ${list.length} to Ghost…`);
      try { await ghostSend(it); ok++; } catch (e) { bad++; why = e.message; if (/isn't answering|token/.test(why)) break; }
    }
    setBar(!bad ? `${ok} sent to Ghost Downloader.` : ok ? `${ok} sent to Ghost, ${bad} failed: ${why}` : why, bad ? "err" : "ok", true);
  }

  // ---------- a button under each video on the page ----------
  // Pointing at a video (or an audio player) shows "Download this media" just under it, or inside its top edge when
  // there's no room below. It opens the panel on that media's row, focused and lit, ready for Save or Ghost. A stream
  // the player feeds through a blob: address is matched to the stream found on the network.
  let pill = null, pillFor = null, pillHide = 0, pillRaf = 0;
  const pillOn = () => store.get("pill", true);
  function mediaAt(x, y) {
    for (const v of document.querySelectorAll("video, audio[controls]")) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 30 || getComputedStyle(v).visibility === "hidden") continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom + 48) return v;
    }
    return null;
  }
  function itemFor(v) {
    const g = groups(), list = [...g.video, ...g.audio], src = v.currentSrc || v.src;
    if (src && !/^blob:/.test(src)) { const u = whole(abs(src) || ""), hit = list.find((it) => it.url === u); if (hit) return hit; }
    return list.find((it) => it.kind === "yt") || list.find((it) => it.kind === "hls") || list.find((it) => it.kind === "dash")
      || list.find((it) => it.kind === (v.tagName === "AUDIO" ? "audio" : "video")) || null;
  }
  function showPill(v) {
    mount(); if (!root) return;
    clearTimeout(pillHide);
    if (!pill) {
      pill = mk("div", "pill"); pill.setAttribute("role", "group"); pill.setAttribute("aria-label", "Omni Downloader");
      pill.onpointerenter = () => clearTimeout(pillHide); pill.onpointerleave = () => hidePill(900);
      root.append(pill);
    }
    const it = itemFor(v);
    if (pillFor !== v || pill.hidden || pill.dataset.url !== (it?.url || "")) {
      const b = btn("", () => { hidePill(0); openAt(it); }, ""); b.append(svg("down"), it ? "Download this media" : "Find media");
      b.title = it ? `${rowName(it)} (${keyNames().join("+")} opens the panel)` : "No file or stream found for this player yet: press play first";
      pill.replaceChildren(b); if (it?.kind === "yt" || it?.kind === "dash" || it?.drm) pill.append(mk("small", null, it.drm ? "DRM" : "Ghost"));
      pill.dataset.url = it?.url || ""; pill.hidden = false; pillFor = v;
    }
    placePill();
  }
  function placePill() {
    if (!pill || pill.hidden || !pillFor) return;
    if (!pillFor.isConnected || document.fullscreenElement) return hidePill(0);
    const r = pillFor.getBoundingClientRect(), w = pill.offsetWidth || 200, h = pill.offsetHeight || 34;
    if (r.bottom < 0 || r.top > innerHeight) return hidePill(0);
    const below = r.bottom + 8 + h <= innerHeight - 8;
    pill.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top + 8)}px`;
    pill.style.left = `${Math.max(8, Math.min(r.left + (below ? 0 : 8), innerWidth - w - 8))}px`;
  }
  function hidePill(ms) { clearTimeout(pillHide); pillHide = setTimeout(() => { if (pill) pill.hidden = true; pillFor = null; }, ms); }
  // opens the panel on one item's row: its tab, scrolled to, focused and lit
  function openAt(it) {
    if (!panel) toggle();
    if (!it) { if (tab !== "video") setTab("video"); return; }
    const t = it.kind === "audio" || soundOnly(it) ? "audio" : "video";
    if (tab !== t) { tab = t; store.set("tab", t); }
    if (query) { query = ""; const q = panel.querySelector(".top input"); if (q) q.value = ""; }
    draw();
    const row = rows.get(it.url)?.el;
    if (!row?.isConnected) return;
    row.scrollIntoView({ block: "nearest" }); row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
    (row.querySelector("[data-k$=':main']") || row.querySelector("button"))?.focus({ preventScroll: true });
    say(`${rowName(it)}. ${row.querySelector("[data-k$=':main']")?.textContent || ""} is ready.`);
  }
  const watchPointer = (e) => {
    if (!pillOn() || pillRaf) return;
    const x = e.clientX, y = e.clientY, touch = e.pointerType === "touch";
    pillRaf = requestAnimationFrame(() => {
      pillRaf = 0;
      if (e.composedPath?.().includes(host)) return; // on the pill or the panel
      const v = mediaAt(x, y);
      if (v) { showPill(v); if (touch) hidePill(4000); } else if (pill && !pill.hidden) hidePill(900);
    });
  };
  window.addEventListener("pointermove", watchPointer, { passive: true });
  window.addEventListener("pointerdown", watchPointer, { passive: true });
  window.addEventListener("scroll", () => placePill(), { passive: true, capture: true });
  window.addEventListener("resize", () => placePill(), { passive: true });

  // ---------- start ----------
  const ready = () => { mount(); setTimeout(() => { try { scan(); } catch {} drawFab(); }, 1500); };
  if (document.body) ready(); else document.addEventListener("DOMContentLoaded", ready, { once: true });
  window.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD" && e.shiftKey === !altD()) { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, true);
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand(`Open Omni Downloader (${keyNames().join("+")})`, () => toggle());
    GM_registerMenuCommand("Show / hide the floating button", () => { store.set("fab", !store.get("fab", true)); drawFab(); });
    GM_registerMenuCommand("Show / hide the button under videos", () => { store.set("pill", !pillOn()); if (!pillOn()) hidePill(0); });
    GM_registerMenuCommand("Shortcut: switch between Alt+Shift+D and Alt+D", () => {
      store.set("key", altD() ? "alt+shift+d" : "alt+d");
      alert(`Omni Downloader now opens with ${keyNames().join("+")}.${altD() ? " (Alt+D no longer moves to the address bar on pages.)" : ""}`);
    });
    GM_registerMenuCommand("Ghost Downloader: port and token", () => {
      const c = ghostCfg(), port = prompt("Ghost Downloader's aria2 RPC port (Settings → aria2 RPC):", String(c.port));
      if (port == null) return;
      const token = prompt("Its RPC token (leave empty if none is set):", c.token);
      if (token == null) return;
      store.set("ghost", { port: Math.min(65535, Math.max(1024, parseInt(port, 10) || 16800)), token: token.trim() });
      ghostCall("aria2.getVersion", []).then((v) => alert(`Ghost Downloader ${v.version} answers.`), (e) => alert(e.message));
    });
  }
})();
