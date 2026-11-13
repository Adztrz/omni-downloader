// ==UserScript==
// @name         Omni Downloader
// @namespace    https://github.com/Adztrz
// @version      1.6
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
  // returns a note for the Save button, if there's something to say
  async function saveDirect(it) {
    if (it.hlsAudio || EXT.hls.test(it.url)) return saveHlsAudio(it);
    const name = fileName(it, it.kind === "image" ? "jpg" : it.kind === "audio" ? "mp3" : "mp4");
    if (it.kind === "video" && /^https?:/.test(it.url)) return saveVideo(it, BILI.test(it.url) ? `${clean(it.title || document.title)}.mp4` : name);
    if (typeof GM_download === "function" && /^https?:/.test(it.url)) {
      try {
        await new Promise((resolve, reject) => GM_download({ url: it.url, name, headers: { Referer: it.referer || location.href }, onload: resolve, onerror: (e) => reject(new Error(e?.error || "download failed")), ontimeout: () => reject(new Error("timed out")) }));
        return;
      } catch (e) { if (!/not_whitelisted|not_enabled|not_permitted/i.test(String(e.message))) throw e; } // file type not allowed in Tampermonkey's settings: save it ourselves
    }
    saveBlob(new Blob([await getRetry(it.url, "buffer", it.referer)]), name);
  }

  // ---------- picture and sound in separate files (Instagram, Facebook and other DASH players) ----------
  // Such a site keeps a video's picture in one MP4 and its sound in another, and its player plays both. Save fetches the
  // picture file, and when it has no sound track, finds the sound file that goes with it (the same asset id in Instagram's
  // efg parameter, else the same length) and joins the two into one MP4 with both tracks. Nothing is re-encoded: the boxes
  // are copied and only track numbers, timescales and offsets are rewritten. Fragmented MP4 (what DASH serves) and plain
  // MP4 with one mdat are both handled; anything else is saved as it came.
  async function saveVideo(it, name) {
    const V = new Uint8Array(await getRetry(it.url, "buffer", it.referer)), vi = mp4Info(V);
    const has = (info, h) => !!info?.traks.some((t) => t.handler === h);
    if (vi && !has(vi, "vide") && has(vi, "soun")) { saveBlob(new Blob([V], { type: "audio/mp4" }), name.replace(/\.\w+$/, "") + ".m4a"); return "Saved (sound only)"; }
    if (!has(vi, "vide") || has(vi, "soun")) { saveBlob(new Blob([V], { type: "video/mp4" }), name); return ""; }
    const pair = await soundFor(it);
    if (pair) {
      try {
        const A = new Uint8Array(await getRetry(pair.url, "buffer", pair.referer || it.referer)), ai = mp4Info(A);
        if (has(ai, "soun") && !has(ai, "vide") && ai.frag === vi.frag) {
          saveBlob(new Blob(vi.frag ? joinFragmented(V, vi, A, ai) : joinPlain(V, vi, A, ai), { type: "video/mp4" }), name);
          return "Saved with sound";
        }
      } catch (e) { console.warn("[omni] joining picture and sound failed:", e); }
    }
    saveBlob(new Blob([V], { type: "video/mp4" }), name);
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
  // the ERP Dock's look: Faust's Night Ledger palette, a 48px square button, a panel that opens as a halftone wave of dots
  // from the button's corner, a filter bar on top, segmented tabs, rows that light up on hover
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab, .p { --canvas: #07090b; --card: #090b0c; --raised: #1a1d1e; --edge: #363738; --hair: #262727; --bone: #e9e1dc; --paper: #efefed; --body: #b3b0af; --muted: #8a8b8a;
      --green: #55bc82; --red: #ff6a5c; --blue: #3e7edf; --soft: cubic-bezier(.1, 0, .1, 1); --out: cubic-bezier(.22, 1, .36, 1);
      font: 400 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-feature-settings: "cv11", "tnum"; -webkit-font-smoothing: antialiased; }
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 48px; height: 48px; padding: 0; border: 0; border-radius: 12px; cursor: pointer;
      display: grid; place-items: center; background: var(--card); color: var(--bone);
      box-shadow: inset 0 0 0 1px var(--edge), 0 12px 24px rgba(0,0,0,.35), 0 2px 4px rgba(0,0,0,.3);
      transition: transform .25s var(--out), box-shadow .25s var(--out); animation: in .6s var(--soft) both; }
    .fab:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 1px #696a68, 0 16px 28px rgba(0,0,0,.4), 0 2px 4px rgba(0,0,0,.3); }
    .fab:active { transform: scale(.94); }
    .fab svg { width: 22px; height: 22px; grid-area: 1 / 1; transition: transform .35s var(--out), opacity .2s; }
    .fab svg.x { transform: rotate(-90deg) scale(.6); opacity: 0; }
    .fab[aria-expanded="true"] svg.open { transform: rotate(90deg) scale(.6); opacity: 0; } .fab[aria-expanded="true"] svg.x { transform: none; opacity: 1; }
    .fab .n { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--bone); color: var(--canvas);
      font: 600 11px/20px "JetBrains Mono", ui-monospace, monospace; text-align: center; box-shadow: 0 0 0 2px var(--card); }
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
    .tabs button b { font-weight: 500; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; margin-left: 6px; color: inherit; opacity: .8; }
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
    .cell .dim { position: absolute; left: 4px; bottom: 4px; padding: 0 5px; border-radius: 4px; background: rgba(7,9,11,.82); color: var(--paper); font: 11px/18px "JetBrains Mono", ui-monospace, monospace; }
    .cell .ck { position: absolute; top: 6px; left: 6px; width: 18px; height: 18px; border-radius: 5px; background: rgba(7,9,11,.7); box-shadow: inset 0 0 0 1px #696a68; transition: background .15s; }
    .cell.sel .ck { background: var(--bone); box-shadow: none; }
    .cell.sel .ck::after { content: ""; position: absolute; left: 6px; top: 2px; width: 5px; height: 10px; border: solid var(--canvas); border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .row { display: grid; gap: 6px; padding: 10px; border-radius: 8px; transition: background .2s; }
    .row:hover { background: var(--raised); }
    .row + .row { box-shadow: 0 -1px 0 var(--hair); } .row:hover, .row:hover + .row { box-shadow: none; }
    .row .t { color: var(--paper); font-weight: 500; font-size: 13px; overflow-wrap: anywhere; }
    .row .u { font: 11px/1.5 "JetBrains Mono", ui-monospace, monospace; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 2px; }
    .row.m { grid-template-columns: 128px minmax(0, 1fr); gap: 12px; align-items: start; }
    .row .info { display: grid; gap: 4px; min-width: 0; }
    .th { position: relative; width: 128px; aspect-ratio: 16 / 9; border-radius: 6px; overflow: hidden; background: #000; box-shadow: inset 0 0 0 1px var(--hair); cursor: pointer; }
    .th video { width: 100%; height: 100%; object-fit: contain; display: block; }
    .th:empty::after, .th.none::after { content: attr(data-note); position: absolute; inset: 0; display: grid; place-items: center; color: #696a68; font-size: 11px; text-align: center;
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
    .prog { height: 4px; border-radius: 2px; background: var(--hair); overflow: hidden; } .prog i { display: block; height: 100%; width: 0; background: var(--green); transition: width .2s; }
    .msg { font-size: 12px; color: var(--muted); } .msg.err { color: var(--red); } .msg.ok { color: var(--green); }
    .empty { margin: 8px 10px; padding: 28px 12px; border-radius: 8px; text-align: center; color: var(--muted); font-size: 13px;
      background: radial-gradient(circle, rgba(233,225,220,.06) 0 1px, transparent 1.5px) 0 0 / 8px 8px; box-shadow: inset 0 0 0 1px var(--hair); }
    .foot { display: flex; gap: 12px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--muted); }
    kbd { font: 11px "JetBrains Mono", ui-monospace, monospace; padding: 1px 5px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--edge); color: var(--body); }
    button:focus-visible, select:focus-visible, input:focus-visible, .cell:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  `;
  // the halftone wave animates a length, which only works on a registered property (and that can't be done inside a shadow root)
  try { CSS.registerProperty({ name: "--ht-w", syntax: "<length>", inherits: false, initialValue: "9000px" }); } catch {}
  const ICON = {
    down: '<svg class="open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    x: '<svg class="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    find: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    again: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  };
  let host, root, fab, panel, main, query = "", tab = store.get("tab", "video"), minSize = store.get("min", 150);
  const picked = new Set(), jobs = new Map(); // url → { ctl, frac, text, err, done }
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
    g.video.sort((a, b) => (b.kind === "hls") - (a.kind === "hls") || (b.kind === "video") - (a.kind === "video"));
    return g;
  };
  const fold = (t) => String(t || "").toLowerCase();
  const svg = (name) => { const t = document.createElement("template"); t.innerHTML = ICON[name]; return t.content.firstChild; };
  function mount() {
    if (host || !document.body) return;
    host = mk("div"); host.id = "omni-downloader"; root = host.attachShadow({ mode: "closed" });
    root.append(mk("style", null, css));
    fab = btn("", () => toggle(), "fab"); fab.title = "Omni Downloader (Alt+D)"; fab.setAttribute("aria-expanded", "false");
    fab.append(svg("down"), svg("x"), mk("span", "n"));
    root.append(fab); document.documentElement.append(host); drawFab();
  }
  function drawFab() {
    if (!fab) return;
    const n = groups(), media = n.video.length + n.audio.length;
    fab.querySelector(".n").textContent = media ? String(media) : "";
    fab.setAttribute("aria-label", `Omni Downloader: ${media} video and audio, ${n.image.length} images`);
    fab.setAttribute("aria-expanded", String(!!panel && !panel.classList.contains("out")));
    fab.style.display = store.get("fab", true) || panel ? "" : "none";
  }
  let drawT = 0;
  onChange = () => { clearTimeout(drawT); drawT = setTimeout(() => { drawFab(); if (panel && tab !== "image") draw(); }, 400); };
  function toggle() {
    mount(); if (!root) return;
    if (panel) {
      const p = panel; panel = null; main = null; p.classList.add("out"); drawFab();
      setTimeout(() => p.remove(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 230); return;
    }
    try { scan(); } catch {}
    panel = mk("div", "p"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Omni Downloader");
    const opened = panel, done = () => opened.classList.add("done"); // drops the dot mask once the wave has passed
    opened.addEventListener("animationend", done, { once: true }); setTimeout(done, 700); // (a background tab may never end the animation)
    // the filter bar, made once so typing in it isn't interrupted by redraws
    const top = mk("div", "top"), q = mk("input"); q.placeholder = "Filter by name or address…"; q.value = query; q.setAttribute("aria-label", "Filter");
    q.oninput = () => { query = q.value; draw(); };
    q.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); if (q.value) { q.value = query = ""; draw(); } else toggle(); } };
    const again = btn("", () => { try { scan(); } catch {} draw(); }, "shut"); again.append(svg("again")); again.title = "Look again"; again.setAttribute("aria-label", "Look again");
    const shut = btn("", () => toggle(), "shut"); const xs = svg("x"); xs.classList.remove("x"); shut.append(xs); shut.title = "Close (Esc)"; shut.setAttribute("aria-label", "Close");
    top.append(svg("find"), q, again, shut);
    main = mk("div", "main");
    const foot = mk("div", "foot"); foot.innerHTML = "<span><kbd>Alt</kbd> <kbd>D</kbd> open / close</span><span><kbd>Esc</kbd> close</span><span>Double-click an image to save it</span>";
    panel.append(top, main, foot);
    root.append(panel); draw(); drawFab();
  }
  function draw() {
    if (!panel) return;
    for (const it of found.values()) if (it.kind === "hls") hlsLoad(it);
    probeAll();
    const g = groups(), body = main.querySelector(".body"), keep = body ? body.scrollTop : 0;
    main.replaceChildren();
    const tabs = mk("div", "tabs");
    for (const [k, t] of [["video", "Video"], ["image", "Images"], ["audio", "Audio"]]) {
      const n = k === "image" ? g.image.filter(big).length : g[k].length;
      const b = btn(t, () => { tab = k; store.set("tab", k); draw(); }, ""); b.append(mk("b", null, String(n))); b.setAttribute("aria-pressed", String(k === tab)); tabs.append(b);
    }
    main.append(tabs);
    const nb = mk("div", "body");
    if (tab === "image") drawImages(g.image, nb); else drawMedia(g[tab], nb);
    main.append(nb); nb.scrollTop = keep; drawFab();
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
    main.append(bar);
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
      row.append(thumb(it), info); sizeLoad(it);
      info.append(mk("div", "t", rowTitle(it)), mk("div", "u", it.url));
      if (soundOnly(it)) info.append(mk("div", "msg", "Saving its video joins this sound in; save it here for the sound alone."));
      const acts = mk("div", "acts");
      if (it.kind === "hls") hlsActs(it, acts, job);
      else if (it.kind === "dash") acts.append(mk("span", "msg", "DASH isn't saved here: copy the ffmpeg command."));
      else acts.append(btn("Save", async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = "Saving…"; try { b.textContent = (await saveDirect(it)) || "Saved"; } catch (x) { b.textContent = `Failed: ${x.message}`; } }, "b pri"));
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
    if (it.sizeP || !/^https?:/.test(it.url) || it.kind === "hls" || it.kind === "dash") return;
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
  const retitle = (it) => { const t = it.thumb?.nextSibling?.querySelector(".t"); if (t) t.textContent = rowTitle(it); };
  function rowTitle(it) {
    const m = it.meta || {}, top = it.variants?.find((v) => v.res)?.res.split("x")[1];
    const w = it.kind === "hls" ? 0 : m.w || it.w, h = it.kind === "hls" ? 0 : m.h || it.h, d = it.kind === "hls" ? it.dur : m.d;
    const label = soundOnly(it) ? "Sound track" : { hls: "HLS stream", dash: "DASH stream", video: "Video file", audio: "Audio file" }[it.kind] || it.kind;
    return [label, it.frame && "in a frame", w && h && `${w}×${h}`, top && `up to ${top}p`, clock(d), sizeText(it)].filter(Boolean).join(" · ");
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
      if (media.drm || !media.segs.length) throw 0;
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
    // a stream's size is only known by fetching it: estimate it from the quality's bitrate and the length
    const mbps = (v) => v.bw ? ` · ${(v.bw / 1e6).toFixed(1)} Mb/s${it.dur ? ` · ≈ ${bytes(v.bw * it.dur / 8)}` : ""}` : "";
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
  window.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") { e.preventDefault(); toggle(); }
    else if (e.key === "Escape" && panel && document.activeElement === host) { e.preventDefault(); toggle(); } // only while the panel has focus
  }, true);
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Open Omni Downloader (Alt+D)", () => toggle());
    GM_registerMenuCommand("Show / hide the floating button", () => { store.set("fab", !store.get("fab", true)); drawFab(); });
  }
})();
