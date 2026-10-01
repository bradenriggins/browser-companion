// Serves the fixture page and the real content.js source for the Chromium battery.
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const server = http.createServer((req, res) => {
  if (req.url === "/content.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end(fs.readFileSync(path.join(ROOT, "extension/src/content.js")));
  }
  if (req.url === "/test.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end(fs.readFileSync(path.join(ROOT, "test/fixtures/test.js")));
  }
  if (req.url === "/" || req.url === "/form.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(ROOT, "test/fixtures/form.html")));
  }
  res.writeHead(404); res.end();
});
server.listen(18931, "127.0.0.1", () => console.log("fixture server on 18931"));
