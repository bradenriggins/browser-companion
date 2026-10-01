// Harness: serves the probe extension in real Chromium under xvfb, collects trial reports.
const http = require("http");
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "probe-aboutblank");
const PROFILE = path.join(__dirname, "probe-profile");
const mode = process.argv[2] || "plain"; // "plain" | "mab"

const manifest = {
  manifest_version: 3, name: "aboutblank-probe", version: "1",
  permissions: ["scripting"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "sw.js" },
};
if (mode === "mab") {
  manifest.content_scripts = [{
    matches: ["<all_urls>"], js: ["probe.js"],
    match_about_blank: true, run_at: "document_start", all_frames: false,
  }];
}
fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log("manifest mode:", mode);

const results = {};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/report") {
    results[u.searchParams.get("name")] = u.searchParams.get("result");
    res.end("ok");
    if (u.searchParams.get("name") === "DONE") finish();
  } else { res.statusCode = 404; res.end(); }
});

let finished = false, ctx = null;
function finish() {
  if (finished) return;
  finished = true;
  console.log("MODE:", mode);
  for (const [k, v] of Object.keys(results).sort().map((k) => [k, results[k]])) console.log(k, "=>", v);
  server.close();
  (ctx ? ctx.close() : Promise.resolve()).then(() => process.exit(0), () => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

(async () => {
  server.listen(18999, "127.0.0.1");
  ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: "/opt/meta-chromium/chrome",
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage",
      `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  setTimeout(() => { console.log("TIMEOUT, partial:", JSON.stringify(results, null, 1)); process.exit(2); }, 90000).unref();
})().catch((e) => { console.error("HARNESS ERROR", e.message); process.exit(2); });
