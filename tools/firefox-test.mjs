// Test the userscript in headless Firefox (WebDriver BiDi), the browser it is mostly used in: the script is injected
// before the page loads, like Tampermonkey, the pointer moves and presses like a hand (press: 150 ms held). Throwaway profile.
// S=<scratch dir> SCRIPT=<script with its @require libraries prepended> URL=<page> STEPS=<json> node tools/firefox-test.mjs
// steps: {move:[x,y]} {click:[x,y]} {press:[x,y]} {js:"expr"} {wait:ms} {shot:"name"} (screenshots to $S/shots, downloads to $S/dl)
import { spawn } from "child_process"; import fs from "fs";
const S = process.env.S, prof = S + "/ffprof"; fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof);
fs.writeFileSync(prof + "/user.js", `user_pref("remote.active-protocols", 1);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("media.autoplay.default", 0);\nuser_pref("browser.download.folderList", 2);\nuser_pref("browser.download.dir", "${S}/dl");\nuser_pref("browser.download.useDownloadDir", true);\nuser_pref("browser.download.always_ask_before_handling_new_types", false);\nuser_pref("browser.download.start_downloads_in_tmp_dir", false);\n`);
const ff = spawn("firefox", ["--headless", "--remote-debugging-port", "9341", "--profile", prof, "--no-remote", "--width", "1400", "--height", "900"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 60; i++) { try { ws = new WebSocket("ws://127.0.0.1:9341/session"); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; }); break; } catch { ws = null; await sleep(500); } }
if (!ws) { console.log("no BiDi"); ff.kill(); process.exit(1); }
let id = 0; const pend = new Map(), logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === "log.entryAdded" && /error|warn/.test(d.params.level) && !/Vue warn/.test(d.params.text)) logs.push(d.params.level + ": " + String(d.params.text).slice(0, 300)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("session.new", { capabilities: {} }); await send("session.subscribe", { events: ["log.entryAdded"] });
const ctx = (await send("browsingContext.getTree", {})).result.contexts[0].context;
await send("browsingContext.setViewport", { context: ctx, viewport: { width: 1400, height: 900 } });
const src = fs.readFileSync(process.env.SCRIPT, "utf8");
const pre = await send("script.addPreloadScript", { functionDeclaration: `() => { try { const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return o.call(this, { ...i, mode: "open" }); };\n${src}\n} catch (e) { window.__omniErr = String(e && e.stack || e); } }` });
if (pre.error) console.log("preload", JSON.stringify(pre).slice(0, 300));
await send("browsingContext.navigate", { context: ctx, url: process.env.URL, wait: "complete" }); await sleep(+(process.env.LOAD || 8000));
const ev = async (expr) => { const r = await send("script.evaluate", { expression: expr, target: { context: ctx }, awaitPromise: true, resultOwnership: "none" }); const v = r.result?.result; return r.error ? "ERR " + r.message : v?.type === "exception" || r.result?.type === "exception" ? "EXC " + JSON.stringify(r.result.exceptionDetails?.text || r.result) : v?.value ?? v?.type; };
const ptr = (acts) => send("input.performActions", { context: ctx, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: acts }] });
for (const s of JSON.parse(process.env.STEPS)) {
  if (s.move) await ptr([{ type: "pointerMove", x: s.move[0], y: s.move[1], duration: 100 }]);
  if (s.click) await ptr([{ type: "pointerMove", x: s.click[0], y: s.click[1] }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
  if (s.press) await ptr([{ type: "pointerMove", x: s.press[0], y: s.press[1], duration: 120 }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 150 }, { type: "pointerUp", button: 0 }]);
  if (s.js) console.log("js →", JSON.stringify(await ev(s.js)));
  if (s.wait) await sleep(s.wait);
  if (s.shot) { const r = await send("browsingContext.captureScreenshot", { context: ctx }); fs.writeFileSync(`${S}/shots/${s.shot}.png`, Buffer.from(r.result.data, "base64")); }
}
console.log("logs", JSON.stringify(logs.slice(0, 8))); ff.kill(); process.exit(0);
