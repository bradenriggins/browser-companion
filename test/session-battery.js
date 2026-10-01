// Session-page battery: proves the REAL content.js draws the banner, answers
// pings, and wires Take over / Stop when loaded as a plain script the way
// src/session.html loads it (the session tab no longer uses about:blank).
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright-core");
const ROOT = path.join(__dirname, "..");

const sessionHtml = fs.readFileSync(path.join(ROOT, "extension/src/session.html"), "utf8");
const csSrc = fs.readFileSync(path.join(ROOT, "extension/src/content.js"), "utf8");
const body = sessionHtml.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "")
  .replace(/<script src="content\.js"><\/script>/, "<!-- content.js inlined below -->");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>session-test</title></head>
<body>${body}
<script>
window.__csListener = null;
window.__sent = [];
window.chrome = { runtime: {
  onMessage: { addListener(fn){ window.__csListener = fn; } },
  sendMessage(msg){ window.__sent.push(msg); return Promise.resolve({}); },
} };
</script>
<script>${csSrc}</script>
<script>
window.__runSession = async () => {
  const out = [];
  const fire = (msg) => new Promise((resolve) => window.__csListener(msg, {}, resolve));
  const ping = await fire({ type: "ping" });
  out.push({ name: "ping answers on session page", ok: !!(ping && ping.ok) });
  const m = await fire({ type: "mask", state: "ongoing" });
  const host = document.getElementById("companion-action-mask");
  out.push({ name: "banner drawn on session page", ok: !!(m && m.ok && host && host.isConnected) });
  const label = host.shadowRoot.querySelector(".label").textContent;
  out.push({ name: "banner label present", ok: /Companion is browsing/.test(label) });
  host.shadowRoot.querySelector(".takeover").click();
  await new Promise((r) => setTimeout(r, 50));
  out.push({ name: "takeover sends paused=true", ok: window.__sent.some((s) => s.type === "takeover" && s.paused === true) });
  const label2 = host.shadowRoot.querySelector(".label").textContent;
  out.push({ name: "takeover flips label", ok: /You have control/.test(label2) });
  host.shadowRoot.querySelector(".stop").click();
  await new Promise((r) => setTimeout(r, 50));
  out.push({ name: "stop sends stopFromPage", ok: window.__sent.some((s) => s.type === "stopFromPage") });
  await fire({ type: "mask", state: "idle" });
  const gone = document.getElementById("companion-action-mask");
  out.push({ name: "banner removed on idle", ok: !gone || !gone.isConnected });
  const idx = await fire({ type: "index" });
  out.push({ name: "index answers", ok: !!(idx && idx.ok && Array.isArray(idx.elements)) });
  return out;
};
</script></body></html>`;

const outPath = path.join(ROOT, "test", "session-page.html");
fs.writeFileSync(outPath, html);

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/meta-chromium/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto("file://" + outPath, { waitUntil: "load" });
  const results = await page.evaluate(() => window.__runSession());
  await browser.close();
  let failed = 0;
  for (const r of results) { console.log((r.ok ? "PASS " : "FAIL ") + r.name); if (!r.ok) failed++; }
  if (errors.length) { console.log("PAGE ERRORS:", errors); failed += errors.length; }
  console.log(failed ? `SESSION-PAGE: ${failed} FAILURES` : "ALL SESSION-PAGE TESTS PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e.message); process.exit(2); });
