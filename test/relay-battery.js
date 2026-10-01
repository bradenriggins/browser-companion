/* Donnie Browser Companion - relay behavioral battery.
 * Spins a fresh relay on a test port with a temp data dir and probes the
 * security-critical behavior: malformed WS frames, pairing entropy/single-use/
 * rate-limit, revocation, browser/session binding, consent state machine,
 * disconnect cleanup, and restart reconciliation.
 * Run: node ~/workspace/donnie-browser/test/relay-battery.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
let WebSocket;
try { WebSocket = require("../relay/node_modules/ws"); }
catch { WebSocket = require("ws"); } // npm install in test/

const PORT = 18999;
// Persistent scratch dir under the project (standing rule: never /tmp).
const SCRATCH = path.join(__dirname, "scratch-relay");
const SRV = path.join(__dirname, "..", "relay", "server.js");
if (!fs.existsSync(SCRATCH)) fs.mkdirSync(SCRATCH, { recursive: true });
const DATA = fs.mkdtempSync(path.join(SCRATCH, "dbc-relay-test-"));
const results = [];
let passed = 0;
function t(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  if (ok) passed++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + String(detail).slice(0, 160) : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, pth, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pth, method, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const srv = spawn("node", [path.join(__dirname, "..", "relay", "server.js")], {
    env: { ...process.env, DBC_PORT: String(PORT), DBC_DATA: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  srv.stdout.on("data", (c) => (out += c));
  srv.stderr.on("data", (c) => (out += c));
  await sleep(1200);
  t("relay boots on test port", out.includes(`listening on 127.0.0.1:${PORT}`), out.trim().split("\n").pop());

  const agentToken = fs.readFileSync(path.join(DATA, "config.json"), "utf8").match(/"agentToken": "([0-9a-f]+)"/)[1];
  const H = { Authorization: `Bearer ${agentToken}` };

  // 1. malformed WebSocket frames must not crash the relay (finding #1)
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => ws1.on("open", r));
  for (const raw of ["null", "42", '"str"', "[1,2]", "{bad json", ""]) {
    ws1.send(raw);
    await sleep(60);
  }
  t("null/primitive/array/malformed WS frames ignored, relay alive", srv.exitCode === null);
  const ws1b = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((r) => ws1b.on("open", r));
  t("relay still accepts new connections after bad frames", ws1b.readyState === 1);

  // 2. unauthenticated hello behavior
  const badHello = await new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
    w.on("close", (code) => resolve(code));
    w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: "nope" })));
    setTimeout(() => resolve("timeout"), 3000);
  });
  t("hello with bad token closed (4003)", badHello === 4003, `code=${badHello}`);
  ws1.close(); ws1b.close();

  // 3. agent auth
  const unauth = await httpReq("GET", "/api/browsers", null, { Authorization: "Bearer wrong" });
  t("bad agent token -> 401", unauth.status === 401);
  const authed = await httpReq("GET", "/api/browsers", null, H);
  t("good agent token -> 200", authed.status === 200);

  // 4. pairing: entropy, single-use, expiry
  const codes = new Set();
  for (let i = 0; i < 20; i++) codes.add(require("child_process").execSync(`DBC_DATA=${DATA} node ${SRV} gencode`, { encoding: "utf8" }).split("\n")[0]);
  t("pairing codes unique (20/20)", codes.size === 20);
  t("pairing code format DB-<32 hex>", [...codes].every((c) => /^DB-[0-9A-F]{32}$/.test(c)), [...codes][0]);
  const code1 = [...codes][0];
  const p1 = await httpReq("POST", "/pair", { code: code1, browserName: "Test-1" });
  t("valid code pairs -> 200 + deviceToken", p1.status === 200 && !!p1.body.deviceToken && !!p1.body.browserId);
  const p1b = await httpReq("POST", "/pair", { code: code1, browserName: "Test-1" });
  t("code is single-use", p1b.status === 403, `status=${p1b.status}`);
  const expired = "DB-" + "00".repeat(16);
  const pExp = loadPairingWrite(expired);
  void pExp;
  const p2 = await httpReq("POST", "/pair", { code: "DB-INVALIDCODE0000000000000000000", browserName: "x" });
  t("bogus code -> 403", p2.status === 403);
  // the expired slot written above must actually be rejected (previously the
  // helper ran but its code was never tried, so expiry was untested)
  const pExpTry = await httpReq("POST", "/pair", { code: expired, browserName: "x" });
  t("expired code -> 403", pExpTry.status === 403, `status=${pExpTry.status}`);

  // 5. pairing rate limit: 10/min; burn through the rest quickly
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await httpReq("POST", "/pair", { code: "DB-INVALID" + i, browserName: "x" });
    if (r.status === 429) { got429 = true; break; }
  }
  t("pairing rate-limited after ~10 attempts", got429);

  // 6. revocation (finding #6)
  const tokA = p1.body.deviceToken;
  const rev = await httpReq("POST", "/revoke", { deviceToken: tokA });
  t("revoke -> 200", rev.status === 200 && rev.body.ok);
  const helloRevoked = await new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
    w.on("close", (code) => resolve(code));
    w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: tokA, browserName: "Test-1", clientId: "c1" })));
    setTimeout(() => resolve("timeout"), 3000);
  });
  t("revoked token cannot hello (4003)", helloRevoked === 4003, `code=${helloRevoked}`);

  // 7. connect two browsers; session binding (finding #3)
  async function pairFresh(name) {
    const code = require("child_process").execSync(`DBC_DATA=${DATA} node ${SRV} gencode`, { encoding: "utf8" }).split("\n")[0];
    const r = await httpReq("POST", "/pair", { code, browserName: name });
    if (r.status !== 200) throw new Error("pair failed: " + r.status + " " + JSON.stringify(r.body));
    return r.body;
  }
  // rate limit window may be hot; wait for it to cool
  await sleep(61000);
  const devA = await pairFresh("Browser-A");
  const devB = await pairFresh("Browser-B");
  function connectBrowser(dev) {
    return new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const msgs = [];
      w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: dev.deviceToken, browserName: "n", clientId: "c", activeSessions: [] })));
      w.on("message", (d) => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "welcome") resolve({ w, msgs, browserId: m.browserId }); });
      w.on("error", reject);
      setTimeout(() => reject(new Error("no welcome")), 5000);
    });
  }
  const A = await connectBrowser(devA);
  const B = await connectBrowser(devB);
  t("both browsers connected, distinct ids", A.browserId !== B.browserId, `${A.browserId} vs ${B.browserId}`);

  const sA = await httpReq("POST", "/api/sessions", { browserId: A.browserId, reason: "test A" }, H);
  t("session request -> pending", sA.status === 200 && sA.body.state === "pending");
  const sidA = sA.body.sessionId;

  // B tries to flip A's session: consent event for A's session over B's socket
  B.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sidA, state: "active" }));
  await sleep(300);
  const sAState = await httpReq("GET", `/api/sessions/${sidA}`, null, H);
  t("browser B cannot flip browser A's session", sAState.body.state === "pending", `state=${sAState.body.state}`);

  // A legitimately allows it
  A.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sidA, state: "active", tabId: 11 }));
  await sleep(300);
  const sA2 = await httpReq("GET", `/api/sessions/${sidA}`, null, H);
  t("own browser consent -> active", sA2.body.state === "active" && sA2.body.tabId === 11);

  // stale consent resurrection (finding #4): active -> denied must be ignored
  A.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sidA, state: "denied", reason: "late" }));
  await sleep(300);
  const sA3 = await httpReq("GET", `/api/sessions/${sidA}`, null, H);
  t("terminal session ignores late consent event", sA3.body.state === "active", `state=${sA3.body.state}`);

  // 8. action_result from the wrong browser is ignored (hardening)
  // agent dispatches an action to A, B tries to resolve it
  const actP = httpReq("POST", "/api/act", { sessionId: sidA, action: { type: "view" } }, H);
  await sleep(400); // let the relay forward the action to A's socket
  const fwd = A.msgs.find((m) => m.type === "action");
  t("relay forwarded action to owning browser", !!fwd, fwd ? `id=${fwd.id}` : "none");
  if (fwd) {
    B.w.send(JSON.stringify({ type: "action_result", id: fwd.id, status: "success", result: { forged: true } }));
    const early = await Promise.race([actP.then((r) => ({ done: true, r })), sleep(800).then(() => ({ done: false }))]);
    t("wrong-browser action_result does not resolve the action", !early.done);
    A.w.send(JSON.stringify({ type: "action_result", id: fwd.id, status: "success", result: { ok: 1 } }));
    const fin = await actP;
    t("own-browser action_result resolves", fin.status === 200 && fin.body.status === "success");
  }

  // 9. disconnect cleanup: sessions ended, pending actions fail fast
  const sB = await httpReq("POST", "/api/sessions", { browserId: B.browserId, reason: "test B" }, H);
  const sidB = sB.body.sessionId;
  B.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sidB, state: "active", tabId: 22 }));
  await sleep(300);
  B.w.close();
  await sleep(500);
  const sB2 = await httpReq("GET", `/api/sessions/${sidB}`, null, H);
  t("browser disconnect ends its sessions", sB2.body.state === "ended", `state=${sB2.body.state}`);
  const sA4 = await httpReq("GET", `/api/sessions/${sidA}`, null, H);
  t("other browser's session untouched by disconnect", sA4.body.state === "active");

  // 10. restart reconciliation: relay forgets nothing here, but the extension
  // reporting an empty activeSessions list must end relay-side sessions
  const devC = await pairFresh("Browser-C");
  const C = await connectBrowser(devC);
  const sC = await httpReq("POST", "/api/sessions", { browserId: C.browserId, reason: "test C" }, H);
  C.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sC.body.sessionId, state: "active", tabId: 33 }));
  await sleep(300);
  // simulate extension restart: new socket, hello claims no surviving sessions
  const C2 = await connectBrowser(devC);
  t("welcome lists known sessions", Array.isArray(C2.msgs.find((m) => m.type === "welcome").sessions));
  await sleep(300);
  const sC2 = await httpReq("GET", `/api/sessions/${sC.body.sessionId}`, null, H);
  t("extension restart without the session ends it relay-side", sC2.body.state === "ended", `state=${sC2.body.state}`);

  // 10b. relay restart orphan: extension reports a session the (fresh) relay
  // never knew. The relay must send an explicit session_end for it (in
  // addition to the welcome.sessions list), so the extension cleans up even
  // if its welcome-reconcile path fails. REGRESSION for the live 2026-10-01
  // defect where the orphan lingered with no session_ended event.
  {
    const devD = await pairFresh("Browser-D");
    // fresh relay state: no sessions; extension hello claims one survivor
    const D = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const msgs = [];
      w.on("message", (d) => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "welcome") resolve({ w, msgs, browserId: m.browserId }); });
      w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: devD.deviceToken, activeSessions: ["orphan-123"] })));
      setTimeout(() => reject(new Error("no welcome")), 5000);
    });
    await sleep(300);
    const endMsg = D.msgs.find((m) => m.type === "session_end" && m.sessionId === "orphan-123");
    t("relay sends session_end for orphan reported in hello", !!endMsg, JSON.stringify(D.msgs.map((m) => m.type)));
    t("orphan session_end names the relay-restart reason", !!endMsg && /forgot|restart/i.test(endMsg.reason || ""), endMsg ? endMsg.reason : "no msg");
    const welcome = D.msgs.find((m) => m.type === "welcome");
    t("welcome still lists known sessions (empty after restart)", welcome && Array.isArray(welcome.sessions) && welcome.sessions.length === 0,
      JSON.stringify(welcome && welcome.sessions));
    D.w.close();
  }

  // 10c. relay records session_ended confirmation for an unknown session.
  // REGRESSION for the live 2026-10-01 defect: after a relay restart, the
  // extension DID send session_ended for the orphan, but the fresh relay
  // silently dropped it because sessions.get() returned undefined. The
  // confirmation must be audited even when the relay forgot the session.
  {
    const devE = await pairFresh("Browser-E");
    const E = await new Promise((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const msgs = [];
      w.on("message", (d) => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "welcome") resolve({ w, msgs, browserId: m.browserId }); });
      w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: devE.deviceToken, activeSessions: ["orphan-456"] })));
      setTimeout(() => reject(new Error("no welcome")), 5000);
    });
    await sleep(300);
    // extension confirms the orphan cleanup; relay never knew this session
    E.w.send(JSON.stringify({ type: "event", kind: "session_ended", sessionId: "orphan-456", reason: "relay forgot session across restart" }));
    await sleep(300);
    const auditPath = path.join(DATA, "audit.jsonl");
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .filter((l) => l.kind === "session_ended" && l.sessionId === "orphan-456");
    t("relay audits session_ended for unknown session", lines.length > 0, `found=${lines.length}`);
    t("unknown session_ended is flagged", lines.length > 0 && lines[0].unknownSession === true, JSON.stringify(lines[0] || {}));
    E.w.close();
  }

  // 11. oversized body rejected
  const big = await httpReq("POST", "/pair", { code: "x".repeat(6 * 1024 * 1024) });
  t("oversized body rejected with 413", big.status === 413, `status=${big.status}`);

  // 12. audit file is created on a fresh data dir and entries are appended
  // (regression: statSync-first logic silently dropped every entry when the
  // file did not exist yet)
  const auditPath = path.join(DATA, "audit.jsonl");
  const auditExists = fs.existsSync(auditPath);
  let auditLines = [];
  if (auditExists) auditLines = fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
  t("audit file created on fresh data dir", auditExists, auditPath);
  t("audit entries recorded", auditLines.length > 0, `${auditLines.length} lines`);
  let auditJsonOk = true, hasConsent = false;
  for (const ln of auditLines) {
    try { const e = JSON.parse(ln); if (e.kind === "session_consent") hasConsent = true; }
    catch { auditJsonOk = false; }
  }
  t("audit lines are valid JSON", auditJsonOk);
  t("audit captured session_consent", hasConsent);

  // 13. POST /api/sessions send-guard. Pre-fix failure mode: unguarded
  // b.ws.send threw on a mid-close socket -> 500 via the outer catch AND the
  // fresh pending session stayed in the map (ghost). Current code rolls the
  // entry back (sessions.delete) and answers 502. A synchronous send throw is
  // not deterministically inducible against a live ws socket, so the rollback
  // branch is pinned statically while the live half proves error-not-hang.
  {
    const srvSrc = fs.readFileSync(path.join(__dirname, "..", "relay", "server.js"), "utf8");
    const at = srvSrc.indexOf('"/api/sessions"');
    const slice = srvSrc.slice(at, at + 2000);
    t("POST /api/sessions guards b.ws.send with rollback + 502",
      at >= 0 && slice.includes("try") && slice.includes("sessions.delete(sessionId)") && slice.includes("502"),
      "guard present");
    const t0 = Date.now();
    const r = await httpReq("POST", "/api/sessions", { browserId: "deadbeefdeadbeef", reason: "ghost?" }, H);
    const dt = Date.now() - t0;
    t("session request for unknown browser -> error, not hang",
      (r.status === 404 || r.status === 502) && dt < 5000, `status=${r.status} dt=${dt}ms`);
    const alive = await httpReq("GET", "/api/browsers", null, H);
    t("relay alive after failed session request", alive.status === 200);
  }

  // 14. POST /api/sessions/:id/stop send-guard. Pre-fix: the session_end send
  // threw AFTER the state flip -> 500 with no audit and a scary log. Current
  // code catches the throw, still ends the session, audits, and answers 200
  // (the stop itself succeeded relay-side; there is no error to report).
  {
    const srvSrc = fs.readFileSync(path.join(__dirname, "..", "relay", "server.js"), "utf8");
    const at = srvSrc.indexOf("/stop");
    const slice = srvSrc.slice(at, at + 1500);
    t("POST /stop guards the session_end send (no crash)",
      at >= 0 && slice.includes("try") && slice.includes("session_end"), "guard present");
    // live: stop a session whose browser is long disconnected (sidB/B) -> fast
    // 200, session ended, relay alive (exercises the dead-browser path)
    const r = await httpReq("POST", `/api/sessions/${sidB}/stop`, {}, H);
    t("stop with disconnected browser responds, no crash",
      r.status === 200 && !!(r.body && r.body.ok), `status=${r.status}`);
    const g = await httpReq("GET", `/api/sessions/${sidB}`, null, H);
    t("stopped session state is ended", g.body.state === "ended", `state=${g.body.state}`);
  }

  // 15. oversized WebSocket frame -> 1009, relay stays up. The relay sets an
  // explicit maxPayload (10MB); the ws library closes violators with 1009.
  // Pre-fix (no limit): the giant message would be buffered/handled.
  {
    const devD = await pairFresh("Browser-D-oversize");
    const D = await connectBrowser(devD);
    t("oversize-test browser connected", !!D.browserId);
    const closeCode = await new Promise((resolve) => {
      D.w.on("close", (code) => resolve(code));
      D.w.send(JSON.stringify({ type: "event", kind: "pad", pad: "x".repeat(11 * 1024 * 1024) }));
      setTimeout(() => resolve("timeout"), 8000);
    });
    t("oversized WS message closed with 1009", closeCode === 1009, `code=${closeCode}`);
    const D2 = await connectBrowser(devD);
    t("relay accepts new connections after oversized frame", !!D2.browserId);
    const alive = await httpReq("GET", "/api/browsers", null, H);
    t("relay HTTP alive after oversized frame", alive.status === 200);
    D2.w.close();
    try { D.w.close(); } catch {}
  }

  // 16. per-session FIFO: 3 rapid actions on one session; N+1 must not be
  // dispatched until N's result is recorded. The mock delays its FIRST response
  // 600ms: with the relay FIFO the 2nd dispatch waits (~600ms receipt gap);
  // pre-fix (concurrent dispatch) all 3 receipts bunch within ~100ms.
  {
    const receipts = [];
    const respond = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type !== "action" || !m.action || !m.action.fifo) return;
      receipts.push({ id: m.id, at: Date.now() });
      const delay = receipts.length === 1 ? 600 : 0;
      setTimeout(() => {
        try { A.w.send(JSON.stringify({ type: "action_result", id: m.id, status: "success", result: { echo: m.action.fifo } })); } catch {}
      }, delay);
    };
    A.w.on("message", respond);
    const p1 = httpReq("POST", "/api/act", { sessionId: sidA, action: { type: "view", fifo: "a1" } }, H);
    const p2 = httpReq("POST", "/api/act", { sessionId: sidA, action: { type: "view", fifo: "a2" } }, H);
    const p3 = httpReq("POST", "/api/act", { sessionId: sidA, action: { type: "view", fifo: "a3" } }, H);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    A.w.removeListener("message", respond);
    t("3 rapid actions all succeed", r1.status === 200 && r2.status === 200 && r3.status === 200,
      `${r1.status}/${r2.status}/${r3.status}`);
    const e1 = r1.body && r1.body.result && r1.body.result.echo;
    const e2 = r2.body && r2.body.result && r2.body.result.echo;
    const e3 = r3.body && r3.body.result && r3.body.result.echo;
    t("FIFO results match their own markers", e1 === "a1" && e2 === "a2" && e3 === "a3",
      `${e1}/${e2}/${e3}`);
    let ordered = false, gapInfo = `receipts=${receipts.length}`;
    if (receipts.length === 3) {
      const gap = receipts[1].at - receipts[0].at;
      gapInfo = `gap1-2=${gap}ms`;
      ordered = gap >= 400;
    }
    t("action N+1 dispatched only after N result (FIFO gap)", ordered, gapInfo);
  }

  // 17. exact session/action-result correspondence: two concurrent sessions on
  // one browser, interleaved actions, responses in REVERSE order. Every /api/act
  // response must carry its own sessionId + relay id + marker. Pre-fix: no
  // sessionId in responses, attribution by order only.
  {
    const s1 = await httpReq("POST", "/api/sessions", { browserId: A.browserId, reason: "corr-1" }, H);
    const s2 = await httpReq("POST", "/api/sessions", { browserId: A.browserId, reason: "corr-2" }, H);
    t("two sessions created for correspondence test", s1.status === 200 && s2.status === 200);
    const sid1 = s1.body.sessionId, sid2 = s2.body.sessionId;
    A.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sid1, state: "active", tabId: 101, via: "standing-grant" }));
    A.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sid2, state: "active", tabId: 102, via: "standing-grant" }));
    await sleep(300);
    const inbox = [];
    const coll = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "action" && m.action && m.action.corr) inbox.push(m);
    };
    A.w.on("message", coll);
    const q1 = httpReq("POST", "/api/act", { sessionId: sid1, action: { type: "view", corr: "s1" } }, H);
    const q2 = httpReq("POST", "/api/act", { sessionId: sid2, action: { type: "view", corr: "s2" } }, H);
    for (let i = 0; i < 50 && inbox.length < 2; i++) await sleep(100);
    t("both sessions dispatched concurrently (FIFO is per-session)", inbox.length === 2, `got=${inbox.length}`);
    const byCorr = Object.fromEntries(inbox.map((m) => [m.action.corr, m]));
    // respond in REVERSE order to prove attribution is by id+sessionId, not order
    if (byCorr.s2) A.w.send(JSON.stringify({ type: "action_result", id: byCorr.s2.id, sessionId: sid2, status: "success", result: { echo: "s2" } }));
    await sleep(100);
    if (byCorr.s1) A.w.send(JSON.stringify({ type: "action_result", id: byCorr.s1.id, sessionId: sid1, status: "success", result: { echo: "s1" } }));
    const [rq1, rq2] = await Promise.all([q1, q2]);
    A.w.removeListener("message", coll);
    t("interleaved actions both succeed", rq1.status === 200 && rq2.status === 200);
    const ok1 = rq1.body && rq1.body.sessionId === sid1 && !!rq1.body.id && rq1.body.result && rq1.body.result.echo === "s1";
    const ok2 = rq2.body && rq2.body.sessionId === sid2 && !!rq2.body.id && rq2.body.result && rq2.body.result.echo === "s2";
    t("result 1 matches its sessionId + id + marker", !!ok1,
      JSON.stringify({ sessionId: rq1.body && rq1.body.sessionId, hasId: !!(rq1.body && rq1.body.id) }));
    t("result 2 matches its sessionId + id + marker", !!ok2,
      JSON.stringify({ sessionId: rq2.body && rq2.body.sessionId, hasId: !!(rq2.body && rq2.body.id) }));
    t("results not cross-attributed", !!rq1.body && !!rq2.body && rq1.body.sessionId !== rq2.body.sessionId);
    // a result claiming the WRONG session must not resolve the action
    const inbox2 = [];
    const coll2 = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "action" && m.action && m.action.corr === "s1b") inbox2.push(m);
    };
    A.w.on("message", coll2);
    const q3 = httpReq("POST", "/api/act", { sessionId: sid1, action: { type: "view", corr: "s1b" } }, H);
    for (let i = 0; i < 50 && inbox2.length < 1; i++) await sleep(100);
    if (inbox2.length) {
      A.w.send(JSON.stringify({ type: "action_result", id: inbox2[0].id, sessionId: sid2, status: "success", result: { echo: "FORGED" } }));
      const early = await Promise.race([q3.then((r) => ({ done: true, r })), sleep(800).then(() => ({ done: false }))]);
      t("wrong-sessionId action_result does not resolve", !early.done);
      A.w.send(JSON.stringify({ type: "action_result", id: inbox2[0].id, sessionId: sid1, status: "success", result: { echo: "s1b" } }));
    } else t("wrong-sessionId probe dispatched", false, "no dispatch");
    const rq3 = await q3;
    A.w.removeListener("message", coll2);
    t("correct-sessionId result resolves", rq3.status === 200 && rq3.body.sessionId === sid1 &&
      rq3.body.result && rq3.body.result.echo === "s1b");
  }

  // 18. audit fields: session_consent carries via + tabId, action carries browserId.
  {
    const s = await httpReq("POST", "/api/sessions", { browserId: A.browserId, reason: "audit-fields" }, H);
    const sid = s.body.sessionId;
    A.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sid, state: "active", tabId: 777, via: "standing-grant" }));
    await sleep(300);
    const lines = fs.readFileSync(path.join(DATA, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const consent = lines.filter((e) => e.kind === "session_consent" && e.sessionId === sid).pop();
    t("audit session_consent carries via + tabId",
      !!consent && consent.via === "standing-grant" && consent.tabId === 777, JSON.stringify(consent));
    const acts = lines.filter((e) => e.kind === "action");
    t("audit action entries exist", acts.length > 0, `${acts.length}`);
    t("audit action entries carry browserId", acts.length > 0 && acts.every((e) => !!e.browserId),
      JSON.stringify(acts[0]));
  }

  // 19. socket errors: logged + cleaned up, never fatal. (a) a raw protocol
  // violation (unmasked client frame) must not kill the relay; (b) an abrupt
  // terminate of an authed browser delists it and ends its sessions.
  // Pre-fix (no ws 'error' listener): Node throws on 'error' and the relay dies.
  {
    const devE = await pairFresh("Browser-E-err");
    const E = await connectBrowser(devE);
    const sE = await httpReq("POST", "/api/sessions", { browserId: E.browserId, reason: "err-test" }, H);
    E.w.send(JSON.stringify({ type: "event", kind: "session_consent", sessionId: sE.body.sessionId, state: "active", tabId: 555 }));
    await sleep(300);
    await new Promise((resolve) => {
      const sock = net.connect(PORT, "127.0.0.1", () => {
        sock.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        if (buf.includes("\r\n\r\n")) {
          try { sock.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); } catch {}
        }
      });
      sock.on("close", () => resolve());
      sock.on("error", () => resolve());
      setTimeout(resolve, 3000);
    });
    await sleep(300);
    const alive1 = await httpReq("GET", "/api/browsers", null, H);
    t("relay survives protocol-violation socket error", alive1.status === 200);
    E.w.terminate();
    await sleep(600);
    const blist = await httpReq("GET", "/api/browsers", null, H);
    const stillThere = (blist.body.browsers || []).some((b) => b.browserId === E.browserId);
    t("abruptly terminated browser delisted", !stillThere);
    const sE2 = await httpReq("GET", `/api/sessions/${sE.body.sessionId}`, null, H);
    t("terminated browser session ended", sE2.body.state === "ended", `state=${sE2.body.state}`);
    const alive2 = await httpReq("GET", "/api/browsers", null, H);
    t("relay alive after socket error + terminate", alive2.status === 200);
  }

  // 20. revocation full cycle: pair -> hello ok -> revoke -> hello rejected.
  // Revocation exists as POST /revoke; a revoked hello closes 4003. (No audit
  // on failed hellos by design: unauthenticated clients could spam the log.
  // The revoke itself audits device_revoked.)
  {
    const code = require("child_process").execSync(`DBC_DATA=${DATA} node ${SRV} gencode`, { encoding: "utf8" }).split("\n")[0];
    const pr = await httpReq("POST", "/pair", { code, browserName: "RevokeCycle" });
    t("revoke-cycle: pair ok", pr.status === 200 && !!pr.body.deviceToken);
    const tok = pr.body.deviceToken;
    const helloOk = await new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      w.on("message", (d) => { try { if (JSON.parse(d.toString()).type === "welcome") { w.close(); resolve(true); } } catch {} });
      w.on("close", () => resolve(false));
      w.on("error", () => resolve(false));
      w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: tok, browserName: "RC", clientId: "rc1" })));
      setTimeout(() => resolve(false), 3000);
    });
    t("revoke-cycle: hello accepted before revoke", helloOk === true);
    const rv = await httpReq("POST", "/revoke", { deviceToken: tok });
    t("revoke-cycle: revoke ok", rv.status === 200 && !!rv.body.ok);
    const helloDead = await new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      w.on("close", (cd) => resolve(cd));
      w.on("error", () => {});
      w.on("open", () => w.send(JSON.stringify({ type: "hello", deviceToken: tok, browserName: "RC", clientId: "rc1" })));
      setTimeout(() => resolve("timeout"), 3000);
    });
    t("revoke-cycle: hello rejected after revoke (4003)", helloDead === 4003, `code=${helloDead}`);
  }

  A.w.close(); C.w.close(); C2.w.close();
  srv.kill();
  await sleep(400);

  console.log(`\n${passed}/${results.length} relay tests passed`);
  if (passed !== results.length) { process.exitCode = 1; console.log("FAILURES:"); for (const r of results) if (!r.ok) console.log(" -", r.name, r.detail); }
  else console.log("ALL RELAY TESTS PASSED");
}

function loadPairingWrite(code) {
  // helper kept for symmetry with the pairing-file format; not strictly needed
  const p = JSON.parse(fs.readFileSync(path.join(DATA, "pairing.json"), "utf8"));
  p[code] = { expiresAt: Date.now() - 1000 };
  fs.writeFileSync(path.join(DATA, "pairing.json"), JSON.stringify(p));
  return p;
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
