// Builds a single self-contained test page (no network) and drives the REAL
// content.js inside real Chromium via playwright-core.
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright-core");
const ROOT = path.join(__dirname, "..");

const fixture = fs.readFileSync(path.join(ROOT, "test/fixtures/form.html"), "utf8");
const csSrc = fs.readFileSync(path.join(ROOT, "extension/src/content.js"), "utf8");
const testSrc = fs.readFileSync(path.join(ROOT, "test/fixtures/test.js"), "utf8");

// strip the outer <html> wrapper from the fixture, keep body content
const body = fixture.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
// test.js is an IIFE that fetches /content.js; adapt: content.js is inlined instead
let adaptedTest = testSrc.replace(
  /const src = await \(await fetch\("\/content\.js"\)\)\.text\(\);\s*\(0, eval\)\(src\);/,
  "/* content.js inlined above; already evaluated */");
// test.js is an async IIFE (after a leading comment); convert to a callable async function
adaptedTest = adaptedTest.replace(/\(async \(\) => \{/, "async () => {").replace(/\}\)\(\);\s*$/, "}");
// chrome is stubbed before content.js in the page; drop the test's own re-stub
// (it would wipe the already-registered listener)
adaptedTest = adaptedTest.replace(
  /window\.__csListener = null;\s*window\.chrome = \{ runtime: \{ onMessage: \{ addListener\(fn\) \{ window\.__csListener = fn; \} \} \} \};/,
  "/* chrome stubbed in page head; content.js already registered */");

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>battery</title>
<style>body{font-family:sans-serif;margin:0;padding:24px}.tall{height:3000px;background:#eee}.hidden-link{position:absolute;top:2500px;left:100px}</style>
<script>const decoy="zebra";</script></head><body>${body}
<script>
window.__csListener = null;
window.chrome = { runtime: { onMessage: { addListener(fn){ window.__csListener = fn; } } } };
</script>
<script>${csSrc}</script>
<script>
window.__runBattery = ${adaptedTest};
</script></body></html>`;
const outPath = path.join(ROOT, "test/battery-page.html");
fs.writeFileSync(outPath, html);
console.log("wrote", outPath, html.length, "bytes");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/meta-chromium/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto("file://" + outPath, { waitUntil: "load" });
  const out = await page.evaluate(() => window.__runBattery());
  await browser.close();
  console.log(JSON.stringify({ pageErrors: errors, passed: out.passed, total: out.total }, null, 1));
  for (const r of out.results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.detail ? " | " + r.detail : ""));
  const failed = out.results.filter((r) => !r.ok);
  if (failed.length || errors.length) process.exit(1);
  console.log("ALL CONTENT.JS TESTS PASSED");
})().catch((e) => { console.error("HARNESS ERROR", e.message); process.exit(2); });
