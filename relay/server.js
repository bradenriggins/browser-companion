/* Browser Companion - relay server (Node 18+)
 * WebSocket for extensions + token-authenticated HTTPS API for the agent.
 * Run on the Meridian VPS:  node server.js
 *   node server.js gencode   -> print a one-time pairing code
 *   node server.js showtoken  -> print the agent API token
 *
 * Depends only on the `ws` package:  npm install
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const DATA = process.env.DBC_DATA || path.join(__dirname, "data");
const PORT = parseInt(process.env.DBC_PORT || "18791", 10);
const HOST = process.env.DBC_HOST || "127.0.0.1"; // localhost only: the browser machine reaches it over a private channel, nothing else needs in
const ACTION_TIMEOUT_MS = 45000;

fs.mkdirSync(DATA, { recursive: true });

function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8")); }
  catch { return fallback; }
}
function saveJson(name, obj) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2));
}

let cfg = loadJson("config.json", null);
if (!cfg) {
  cfg = { agentToken: crypto.randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  saveJson("config.json", cfg);
  console.log("[relay] generated new agent API token (node server.js showtoken to view)");
}
const devices = loadJson("devices.json", {}); // deviceToken -> {browserId, browserName, createdAt}
const saveDevices = () => saveJson("devices.json", devices);

const pairingFile = path.join(DATA, "pairing.json");
function loadPairing() { return loadJson("pairing.json", {}); }
function savePairing(p) { saveJson("pairing.json", p); }
const browsers = new Map();     // browserId -> {ws, browserName, clientId, connectedAt, alive}
const sessions = new Map();     // sessionId -> {browserId, state, reason, createdAt, mode}
const pendingActions = new Map(); // msgId -> {resolve, reject, timer}
const sessionQueues = new Map(); // sessionId -> tail promise (per-session FIFO for /api/act)

const auditPath = path.join(DATA, "audit.jsonl");
function audit(entry) {
  // Size-based rotation so the log can't grow forever. The whole write is
  // guarded so a disk hiccup can never throw inside an event handler and
  // take the relay down with it. The stat is best-effort (a fresh data dir
  // has no file yet); the append always runs and creates the file.
  try {
    try {
      if (fs.statSync(auditPath).size > 5 * 1024 * 1024) {
        fs.renameSync(auditPath, auditPath + ".1");
      }
    } catch {}
    fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) { console.log("[relay] audit write failed", e.message); }
}

const rid = (n = 12) => crypto.randomBytes(n).toString("hex");
// 128-bit pairing codes: brute force over a 10-minute window is infeasible
const newPairCode = () => "DB-" + crypto.randomBytes(16).toString("hex").toUpperCase();

// minimal rate limiter: counts attempts per key in a sliding window
const rateBuckets = new Map(); // key -> {count, windowStart}
function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.windowStart > windowMs) { b = { count: 0, windowStart: now }; rateBuckets.set(key, b); }
  b.count++;
  // occasional cleanup so the map can't grow forever
  if (rateBuckets.size > 1000 && Math.random() < 0.01) {
    for (const [k, v] of rateBuckets) if (now - v.windowStart > windowMs) rateBuckets.delete(k);
  }
  return b.count <= maxAttempts;
}

// ---------- CLI ----------
const cmd = process.argv[2];
if (cmd === "gencode") {
  const code = newPairCode();
  const p = loadPairing();
  p[code] = { expiresAt: Date.now() + 10 * 60 * 1000 };
  savePairing(p);
  console.log(code);
  console.log("(single use, expires in 10 minutes)");
  process.exit(0);
}
if (cmd === "showtoken") {
  console.log(cfg.agentToken);
  process.exit(0);
}

// ---------- HTTP API ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 5 * 1024 * 1024) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function agentAuth(req) {
  const h = req.headers.authorization || "";
  const want = `Bearer ${cfg.agentToken}`;
  const hb = Buffer.from(h), wb = Buffer.from(want);
  return hb.length === wb.length && crypto.timingSafeEqual(hb, wb);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    // --- pairing (unauthenticated, single-use code) ---
    if (req.method === "POST" && url.pathname === "/pair") {
      if (!rateLimit("pair", 10, 60 * 1000)) return json(res, 429, { error: "too many attempts, try again later" });
      const body = await readBody(req);
      const code = String(body.code || "").toUpperCase().trim();
      const p = loadPairing();
      const slot = p[code];
      if (!slot || slot.expiresAt < Date.now()) return json(res, 403, { error: "invalid or expired code" });
      delete p[code];
      savePairing(p);
      const deviceToken = rid(24), browserId = rid(8);
      devices[deviceToken] = { browserId, browserName: String(body.browserName || "browser").slice(0, 40), createdAt: new Date().toISOString() };
      saveDevices();
      audit({ kind: "pair", browserId });
      return json(res, 200, { deviceToken, browserId });
    }
    // --- device revocation (called by the extension itself on unpair) ---
    if (req.method === "POST" && url.pathname === "/revoke") {
      const body = await readBody(req);
      const tok = String(body.deviceToken || "");
      if (tok && devices[tok]) {
        const { browserId } = devices[tok];
        delete devices[tok];
        saveDevices();
        audit({ kind: "device_revoked", browserId });
      }
      return json(res, 200, { ok: true });
    }
    // --- agent API ---
    if (!agentAuth(req)) return json(res, 401, { error: "bad agent token" });

    if (req.method === "GET" && url.pathname === "/api/browsers") {
      return json(res, 200, { browsers: [...browsers.entries()].map(([id, b]) => ({
        browserId: id, browserName: b.browserName, connectedAt: b.connectedAt,
        activeSessions: [...sessions.values()].filter((s) => s.browserId === id && s.state === "active").length,
      })) });
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readBody(req);
      const b = browsers.get(body.browserId);
      if (!b) return json(res, 404, { error: "browser not connected" });
      const sessionId = rid(8);
      sessions.set(sessionId, { browserId: body.browserId, state: "pending", reason: String(body.reason || "").slice(0, 200), createdAt: Date.now() });
      // Guard the send: if the browser socket is mid-close the entry may
      // still be in the map but send throws (or the message is dropped).
      // On failure roll the pending session back instead of leaving a ghost.
      try {
        b.ws.send(JSON.stringify({ type: "session_request", sessionId, reason: sessions.get(sessionId).reason }));
      } catch (e) {
        sessions.delete(sessionId);
        return json(res, 502, { error: "browser socket not writable", detail: String((e && e.message) || e) });
      }
      audit({ kind: "session_request", sessionId, browserId: body.browserId, reason: sessions.get(sessionId).reason });
      return json(res, 200, { sessionId, state: "pending" });
    }
    let m = url.pathname.match(/^\/api\/sessions\/([0-9a-f]+)$/);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: "unknown session" });
      if (req.method === "GET") return json(res, 200, { sessionId: m[1], ...s });
    }
    m = url.pathname.match(/^\/api\/sessions\/([0-9a-f]+)\/stop$/);
    if (m && req.method === "POST") {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: "unknown session" });
      const b = browsers.get(s.browserId);
      // Guard the send the same way as session_request: a mid-close socket
      // must not 500 after the session state was already flipped.
      try {
        b?.ws.send(JSON.stringify({ type: "session_end", sessionId: m[1], reason: "stopped by agent" }));
      } catch (e) {
        console.log("[relay] session_end send failed", m[1], String((e && e.message) || e));
      }
      s.state = "ended";
      audit({ kind: "session_end", sessionId: m[1], reason: "agent stop" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/act") {
      const body = await readBody(req);
      // fast pre-checks so obvious failures never queue; re-validated at
      // dispatch time inside the queue because the session may end while waiting.
      const sPre = sessions.get(body.sessionId);
      if (!sPre || sPre.state !== "active") return json(res, 409, { error: `session not active (state: ${sPre?.state || "unknown"})` });
      if (!browsers.get(sPre.browserId)) return json(res, 404, { error: "browser disconnected" });
      // Per-session FIFO: action N+1 is not dispatched until action N's result
      // is recorded (resolved + audited). Actions for different sessions stay
      // concurrent (one queue per sessionId).
      const prev = sessionQueues.get(body.sessionId) || Promise.resolve();
      const cur = prev.catch(() => {}).then(async () => {
        const s = sessions.get(body.sessionId);
        if (!s || s.state !== "active") return { status: "error", error: `session not active (state: ${s?.state || "unknown"})`, sessionId: body.sessionId };
        const b = browsers.get(s.browserId);
        if (!b) return { status: "error", error: "browser disconnected", sessionId: body.sessionId };
        const id = rid(8);
        const started = Date.now();
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pendingActions.delete(id); reject(new Error("action timeout: browser did not respond")); }, ACTION_TIMEOUT_MS);
          pendingActions.set(id, { resolve, reject, timer, sessionId: body.sessionId, browserId: s.browserId });
          // Guard the send like /api/sessions: a mid-close socket must neither
          // throw out of the executor nor leave a pending entry behind.
          try {
            b.ws.send(JSON.stringify({ type: "action", id, sessionId: body.sessionId, action: body.action }));
          } catch (e) {
            clearTimeout(timer); pendingActions.delete(id);
            reject(new Error("browser socket not writable: " + String((e && e.message) || e)));
          }
        }).catch((e) => ({ status: "error", error: e.message }));
        const ms = Date.now() - started;
        audit({ kind: "action", sessionId: body.sessionId, browserId: s.browserId, action: body.action?.type, status: result.status, ms, error: result.error });
        // Authoritative correspondence: every dispatched result carries the
        // relay-issued id and sessionId so the agent attributes it exactly
        // (never by arrival order).
        return { ...result, id, sessionId: body.sessionId };
      });
      sessionQueues.set(body.sessionId, cur);
      const out = await cur.catch((e) => ({ status: "error", error: String((e && e.message) || e), sessionId: body.sessionId }));
      if (sessionQueues.get(body.sessionId) === cur) sessionQueues.delete(body.sessionId);
      return json(res, 200, out);
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      const sid = url.searchParams.get("sessionId");
      let lines = [];
      try {
        lines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean) : [];
      } catch { lines = []; }
      const entries = [];
      for (const l of lines) {
        try { const e = JSON.parse(l); if (!sid || e.sessionId === sid) entries.push(e); }
        catch { /* skip corrupt lines */ }
      }
      return json(res, 200, { entries: entries.slice(-200) });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    if (e.message === "body too large") return json(res, 413, { error: "body too large" });
    return json(res, 500, { error: String(e.message || e) });
  }
});

// ---------- extension WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 }); // 10MB: screenshots are ~200KB, actions are tiny; anything bigger is abuse
wss.on("error", (e) => console.log("[relay] ws server error", e.message));
wss.on("connection", (ws) => {
  let browserId = null, authed = false;
  const helloTimer = setTimeout(() => { if (!authed) ws.close(4001, "no hello"); }, 10000);
  // Without this, a socket-level error (e.g. TCP reset during disconnect) throws
  // and kills the whole relay. Log it; the close handler does the cleanup.
  ws.on("error", (e) => console.log("[relay] browser socket error", e.message));
  ws.on("message", (raw) => {
    try {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // JSON.parse("null") succeeds: reject non-object payloads before touching msg.type
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      onBrowserMessage(msg);
    } catch (e) { console.log("[relay] browser msg error", e.message); }
  });

  function onBrowserMessage(msg) {
    if (!authed) {
      if (msg.type !== "hello" || !msg.deviceToken || !devices[msg.deviceToken]) {
        ws.close(4003, "bad token"); return;
      }
      clearTimeout(helloTimer);
      authed = true;
      const dev = devices[msg.deviceToken];
      browserId = dev.browserId;
      dev.browserName = String(msg.browserName || dev.browserName).slice(0, 40);
      saveDevices();
      // one connection per browser: drop the old one
      browsers.get(browserId)?.ws.close(4000, "replaced");
      browsers.set(browserId, { ws, browserName: dev.browserName, clientId: msg.clientId, connectedAt: new Date().toISOString() });
      // reconcile first: the extension restarted and forgot sessions the relay
      // still holds (it sends its surviving list in activeSessions). End those
      // here so the welcome list below never names a session we just killed.
      // Audit what the extension reported: if it claims sessions the relay
      // never knew (fresh relay restart), the welcome below tells it to end
      // them locally, and this record proves what was claimed.
      if (Array.isArray(msg.activeSessions)) {
        const unknown = msg.activeSessions.filter((sid) => !sessions.has(sid));
        audit({ kind: "hello_reconcile", browserId, reported: msg.activeSessions, unknown,
          relayKnown: [...sessions.keys()], extVersion: msg.version });
        for (const [sid, s] of sessions) {
          if (s.browserId === browserId && (s.state === "active" || s.state === "pending") && !msg.activeSessions.includes(sid)) {
            s.state = "ended";
            audit({ kind: "session_end", sessionId: sid, reason: "extension restarted, session not restored" });
          }
        }
        // Belt and suspenders: the welcome.sessions list below asks the
        // extension to end orphans via its welcome-reconcile, but that path
        // silently failed live twice (2026-10-01). Send an explicit session_end
        // for each orphan too; the extension's session_end handler is a
        // separate code path and endSession is idempotent, so a double-end
        // is harmless.
        for (const sid of unknown) {
          try { ws.send(JSON.stringify({ type: "session_end", sessionId: sid, reason: "relay restarted and forgot this session" })); } catch {}
          audit({ kind: "orphan_session_end_sent", sessionId: sid, browserId });
        }
      }
      // tell the extension which sessions we still know, so it can end the ones
      // we lost (e.g. relay restart) instead of driving a ghost session
      const knownSessions = [...sessions.entries()]
        .filter(([, s]) => s.browserId === browserId && (s.state === "active" || s.state === "pending"))
        .map(([id]) => id);
      ws.send(JSON.stringify({ type: "welcome", browserId, sessions: knownSessions }));
      audit({ kind: "browser_connected", browserId, browserName: dev.browserName });
      console.log(`[relay] browser connected: ${browserId} (${dev.browserName})`);
      return;
    }
    handleBrowserMessage(browserId, msg);
  }
  ws.on("close", () => {
    if (browserId && browsers.get(browserId)?.ws === ws) {
      browsers.delete(browserId);
      for (const [sid, s] of sessions) {
        if (s.browserId === browserId && (s.state === "active" || s.state === "pending")) {
          s.state = "ended";
          audit({ kind: "session_end", sessionId: sid, reason: "browser disconnected" });
        }
      }
      // fail fast: don't leave the agent hanging 45s on actions for a dead browser
      for (const [id, p] of pendingActions) {
        if (p.browserId === browserId) {
          clearTimeout(p.timer); pendingActions.delete(id);
          p.reject(new Error("browser disconnected mid-action"));
        }
      }
      audit({ kind: "browser_disconnected", browserId });
      console.log(`[relay] browser disconnected: ${browserId}`);
    }
  });
  // relay-initiated ping; extension replies pong
  const pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping", id: rid(4) })); }, 30000);
  ws.on("close", () => clearInterval(pingTimer));
});

function handleBrowserMessage(browserId, msg) {
  switch (msg.type) {
    case "pong": break;
    case "action_result": {
      const p = pendingActions.get(msg.id);
      // only the browser the action was dispatched to may resolve it, and a
      // result claiming a session must claim the action's own session (older
      // extensions omit sessionId entirely, which still resolves).
      if (p && p.browserId === browserId && (!msg.sessionId || p.sessionId === msg.sessionId)) {
        clearTimeout(p.timer); pendingActions.delete(msg.id); p.resolve(msg);
      }
      break;
    }
    case "event": {
      const s = sessions.get(msg.sessionId);
      if (msg.kind === "session_ended" && !s) {
        // Live-proven 2026-10-01: after a relay restart, the extension confirms
        // the orphan cleanup, but the fresh relay forgot the session and was
        // silently dropping the confirmation. Record it; the relay itself sent
        // the session_end that triggered this.
        audit({ kind: "session_ended", sessionId: msg.sessionId, reason: msg.reason, unknownSession: true });
        break;
      }
      if (!s || s.browserId !== browserId) break; // never let one browser flip another's session
      if (msg.kind === "session_consent") {
        // only a pending session may transition; active/denied/ended is terminal
        if (s.state !== "pending") break;
        if (!["active", "denied", "error", "pending"].includes(msg.state)) break;
        s.state = msg.state;
        if (msg.tabId) s.tabId = msg.tabId;
        if (msg.via) s.via = msg.via;
        audit({ kind: "session_consent", sessionId: msg.sessionId, state: msg.state, reason: msg.reason, via: msg.via, tabId: msg.tabId });
      } else if (msg.kind === "session_ended" || msg.kind === "takeover") {
        if (msg.kind === "session_ended") s.state = "ended";
        audit({ kind: msg.kind, sessionId: msg.sessionId, reason: msg.reason, paused: msg.paused });
      }
      break;
    }
    default: console.log("[relay] unknown browser msg", msg.type);
  }
}

// backstop: a pending session the extension never decided (e.g. its SW restarted
// and lost the consent timer) must not linger forever; the extension's own
// timeout is 60s, so 5 minutes here only catches the orphaned ones.
// Active sessions also get a 4h TTL so the map can't grow forever and a
// forgotten session can't drive a tab indefinitely.
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.state === "pending" && now - s.createdAt > 5 * 60 * 1000) {
      s.state = "ended";
      audit({ kind: "session_end", sessionId: sid, reason: "pending consent expired (relay backstop)" });
    } else if (s.state === "active" && now - s.createdAt > 4 * 3600 * 1000) {
      s.state = "ended";
      const b = browsers.get(s.browserId);
      try { b?.ws.send(JSON.stringify({ type: "session_end", sessionId: sid, reason: "4h session TTL" })); } catch {}
      audit({ kind: "session_end", sessionId: sid, reason: "4h session TTL" });
    }
  }
}, 60000);

server.listen(PORT, HOST, () => console.log(`[relay] listening on ${HOST}:${PORT} (data: ${DATA})`));
