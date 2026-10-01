// sw.js battery: loads the REAL service worker source in Node with stubbed
// chrome/CDP, then tests DPR normalization, hash matching, and end-to-end
// click coordinate math (device px -> CSS px -> scroll-corrected client px).
const fs = require("fs"), path = require("path"), vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "sw.js"), "utf8");

// ---- captured CDP traffic ----
const mouseEvents = [];
let fakeSnapshot = null;   // synthetic DOMSnapshot.captureSnapshot result
let fakeDpr = 1, fakeScroll = { x: 0, y: 0 }, fakeViewport = { w: 1280, h: 800 };
const setFilesCalls = []; // captured DOM.setFileInputFiles params
const tabMessages = []; // captured chrome.tabs.sendMessage payloads
const keyEvents = []; // captured Input.dispatchKeyEvent params (press_key/charCode tests)

const chromeStub = {  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: {
    get: async (id) => ({ id, url: "https://example.com", title: "T", width: 1280, height: 800 }),
    sendMessage: (tabId, msg, cb) => { tabMessages.push({ tabId, msg }); if (typeof cb === "function") cb({ ok: true }); return Promise.resolve({ ok: true }); },
    onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
  },
  debugger: {
    onDetach: { addListener() {} },
    sendCommand: async (target, method, params) => {
      if (method === "Input.dispatchMouseEvent") { mouseEvents.push({ ...params }); return {}; }
      if (method === "Input.dispatchKeyEvent") { keyEvents.push({ ...params }); return {}; }
      if (method === "DOMSnapshot.captureSnapshot") return fakeSnapshot;
      if (method === "Runtime.evaluate") {
        const ex = params.expression || "";
        if (ex.includes("devicePixelRatio")) return { result: { value: { dpr: fakeDpr, w: fakeViewport.w, h: fakeViewport.h } } };
        if (ex.includes("scrollX")) return { result: { value: fakeScroll } };
        return { result: { value: null } };
      }
      if (method === "Page.captureScreenshot") return { data: "AAA" };
      if (method === "DOM.setFileInputFiles") { setFilesCalls.push({ ...params }); return {}; }
      return {};
    },
    attach: async () => {}, detach: async () => {},
  },
  runtime: { onMessage: { addListener() {} } },
  notifications: { onButtonClicked: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  scripting: { executeScript: async () => [{}] },
  downloads: {
    search: async (q) => [
      { id: 7, filename: "/Users/x/Downloads/a.pdf", url: "https://x/a.pdf", finalUrl: "https://x/a.pdf",
        state: "complete", bytesReceived: 100, totalBytes: 100, exists: true },
    ],
  },
};

const sandbox = {
  chrome: chromeStub,
  WebSocket: (() => { const C = class { constructor() { this.readyState = 3; } send() {} close() {} }; C.CONNECTING = 0; C.OPEN = 1; C.CLOSING = 2; C.CLOSED = 3; return C; })(),
  crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i = i] = (i * 37) & 0xff; return a; } },
  setInterval: () => 0, clearInterval: () => {},
  console, URL, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "sw.js" });

const { elementsFromSnapshot, findElement, hashStr, runAction } = sandbox;
const S = vm.runInContext("S", sandbox);
const results = [];
const t = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || "" }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : "")); };

// ---- synthetic DOMSnapshot: one button at device-px (400,600) size 200x80 ----
function makeSnap() {
  const strings = ["BUTTON", "Click me", "button"];
  const s = (v) => strings.indexOf(v);
  return {
    strings,
    documents: [{
      nodes: {
        backendNodeId: [1, 2], nodeType: [1, 3], nodeName: [s("BUTTON"), -1],
        attributes: [[], []], parentIndex: [-1, 0], textValue: [-1, s("Click me")],
      },
      layout: { nodeIndex: [0, 1], bounds: [[400, 600, 200, 80], null], paintOrders: [1, 0] },
    }],
  };
}

(async () => {
  // 1. DPR normalization: device px / dpr = CSS px
  fakeSnapshot = makeSnap(); fakeDpr = 2;
  let els = elementsFromSnapshot(fakeSnapshot, 2);
  t("DPR2: device (400,600,200,80) -> CSS (200,300,100,40)",
    els.length === 1 && els[0].x === 200 && els[0].y === 300 && els[0].w === 100 && els[0].h === 40,
    JSON.stringify(els[0]));
  fakeDpr = 1;
  els = elementsFromSnapshot(fakeSnapshot, 1);
  t("DPR1: bounds unchanged", els.length === 1 && els[0].x === 400 && els[0].y === 600, JSON.stringify(els[0]));
  fakeDpr = 2;

  // 2. hash matching
  const session = { elements: els, viewport: fakeViewport };
  const full = els[0].hash;
  t("hashStr deterministic", hashStr("a|b|c|1|2") === hashStr("a|b|c|1|2"));
  let el = findElement(session, { strategy: "byIndex", index: 0, hash: full });
  t("exact hash resolves", el && el.i === 0);
  el = findElement(session, { strategy: "byIndex", index: 0, hash: full.slice(0, 6) });
  t("hash prefix resolves", el && el.i === 0, "prefix=" + full.slice(0, 6));
  let staleErr = "";
  try { findElement(session, { strategy: "byIndex", index: 0, hash: "deadbeef" }); }
  catch (e) { staleErr = e.message; }
  t("wrong hash rejected as stale", /changed since snapshot/.test(staleErr), staleErr);
  let noElErr = "";
  try { findElement(session, { strategy: "byIndex", index: 99 }); } catch (e) { noElErr = e.message; }
  t("bad index rejected", /no element with index 99/.test(noElErr), noElErr);

  // ambiguity: two elements sharing a hash prefix
  const els2 = [
    { i: 0, hash: "abcdef12", x: 0, y: 0, w: 10, h: 10 },
    { i: 1, hash: "abcdef99", x: 0, y: 0, w: 10, h: 10 },
  ];
  let ambErr = "";
  try { findElement({ elements: els2 }, { strategy: "byIndex", index: 7, hash: "abcdef" }); }
  catch (e) { ambErr = e.message; }
  t("ambiguous prefix rejected", /ambiguous target hash/.test(ambErr), ambErr);
  const exactEl = findElement({ elements: els2 }, { strategy: "byIndex", index: 7, hash: "abcdef99" });
  t("exact hash wins over ambiguity", exactEl && exactEl.i === 1);

  // 3. end-to-end click: DPR2, scroll (50, 100), element doc-CSS (200,300,100,40)
  //    center doc (250,320) -> client (250-50, 320-100) = (200,220)
  mouseEvents.length = 0;
  fakeScroll = { x: 50, y: 100 };
  const sess = { tabId: 7, elements: [], viewport: { w: 1280, h: 800 }, lastIndexAt: 0 };
  S.sessions.set("test-sess", sess);
  const action = { type: "click", target: { strategy: "byIndex", index: 0 } };
  const res = await runAction(7, sess, action);
  const pressed = mouseEvents.find((e) => e.type === "mousePressed");
  t("click succeeds", res && res.status === "success", JSON.stringify(res).slice(0, 120));
  t("click dispatched at scroll-corrected client coords (200,220)",
    pressed && pressed.x === 200 && pressed.y === 220,
    "got " + JSON.stringify(pressed));

  // 4. off-viewport click fails loudly instead of clicking empty space
  fakeScroll = { x: 0, y: 0 };
  const sess2 = { tabId: 7, elements: [], viewport: { w: 1280, h: 800 }, lastIndexAt: 0 };
  const sess3 = { tabId: 7, elements: [], viewport: { w: 1280, h: 800 }, lastIndexAt: 0 };
  S.sessions.set("test-sess", sess3);
  // element at doc (200,300) is on-viewport; force off-viewport by shrinking the
  // live viewport (captureIndex refreshes session.viewport from the page)
  fakeViewport = { w: 100, h: 100 };
  let vpErr = "", vpRes = null;
  try { vpRes = await runAction(7, sess3, action); } catch (e) { vpErr = e.message; }
  t("off-viewport click refused", /outside the 100x100 viewport/.test(vpErr), vpErr || JSON.stringify(vpRes).slice(0, 120));

  // 5. navigation scheme guard
  let navErr = "";
  try { await runAction(7, sess2, { type: "navigate", url: "chrome://settings" }); } catch (e) { navErr = e.message; }
  t("chrome:// navigation refused", /non-web url/.test(navErr), navErr);
  let jsErr = "";
  try { await runAction(7, sess2, { type: "navigate", url: "javascript:alert(1)" }); } catch (e) { jsErr = e.message; }
  t("javascript: navigation refused", /non-web url/.test(jsErr), jsErr);

  // 6. list_downloads returns the browser's download shelf
  const dlRes = await runAction(7, sess2, { type: "list_downloads" });
  t("list_downloads succeeds", dlRes && dlRes.status === "success" && dlRes.downloads && dlRes.downloads.length === 1, JSON.stringify(dlRes).slice(0, 160));
  t("list_downloads maps fields", dlRes.downloads[0].filename === "/Users/x/Downloads/a.pdf" && dlRes.downloads[0].state === "complete");

  // 7. upload_file without files fails loudly
  S.sessions.set("test-sess", sess2);
  let upErr = "";
  try { await runAction(7, sess2, { type: "upload_file", target: { strategy: "byIndex", index: 0 }, files: [] }); } catch (e) { upErr = e.message; }
  t("upload_file with empty files refused", /non-empty files array/.test(upErr), upErr);

  // 8. upload_file happy path: backendNodeId passed straight to setFileInputFiles
  setFilesCalls.length = 0;
  const upSess = { tabId: 7, elements: [{ i: 0, hash: "up1", backendId: 1, x: 0, y: 0, w: 10, h: 10 }], viewport: { w: 1280, h: 800 }, lastIndexAt: Date.now() };
  S.sessions.set("test-sess", upSess);
  const upRes = await runAction(7, upSess, { type: "upload_file", target: { strategy: "byIndex", index: 0 }, files: ["/tmp/a.txt"] });
  t("upload_file succeeds with backendNodeId", upRes && upRes.status === "success" && setFilesCalls.length === 1 && setFilesCalls[0].backendNodeId === 1 && setFilesCalls[0].files[0] === "/tmp/a.txt",
    JSON.stringify(setFilesCalls[0] || ""));

  // 9. upload_file from the JS fallback index (no backendId) fails loudly
  const upSess2 = { tabId: 7, elements: [{ i: 0, hash: "up2", backendId: null, x: 0, y: 0, w: 10, h: 10 }], viewport: { w: 1280, h: 800 }, lastIndexAt: Date.now() };
  S.sessions.set("test-sess", upSess2);
  let upErr2 = "";
  try { await runAction(7, upSess2, { type: "upload_file", target: { strategy: "byIndex", index: 0 }, files: ["/tmp/a.txt"] }); } catch (e) { upErr2 = e.message; }
  t("upload_file without CDP node fails loudly", /JS fallback index/.test(upErr2), upErr2);

  // 10. scroll with x/y reaches doScroll as x/y (regression: coordinateX bug)
  tabMessages.length = 0;
  const scrollSess = { tabId: 7, elements: [], viewport: { w: 1280, h: 800 }, lastIndexAt: Date.now() };
  S.sessions.set("test-sess", scrollSess);
  const scrollRes = await runAction(7, scrollSess, { type: "scroll", x: 0, y: 500 });
  const doScrollMsg = tabMessages.find((m) => m.msg && m.msg.type === "doScroll");
  t("scroll succeeds", scrollRes && scrollRes.status === "success", JSON.stringify(scrollRes).slice(0, 120));
  t("scroll passes x/y (not coordinateX/coordinateY) to doScroll",
    doScrollMsg && doScrollMsg.msg.x === 0 && doScrollMsg.msg.y === 500,
    JSON.stringify(doScrollMsg && doScrollMsg.msg));

  // 11. chrome.tabs.create failure during startSession -> no ghost pending
  // session (entry deleted + persistSessions ran). Pre-fix failure mode: the
  // throw left the pending entry in S.sessions forever (ghost) and skipped
  // persist, so the ghost also survived SW restarts via restoreSessions.
  {
    const keep = {
      create: chromeStub.tabs.create, remove: chromeStub.tabs.remove,
      getURL: chromeStub.runtime.getURL, clear: chromeStub.notifications.clear,
      action: chromeStub.action, sessSet: chromeStub.storage.session.set,
    };
    let storageSets = 0;
    chromeStub.tabs.create = async () => { throw new Error("boom: tabs.create failed"); };
    chromeStub.tabs.remove = async () => {};
    chromeStub.runtime.getURL = (p) => "chrome-extension://test/" + p;
    chromeStub.notifications.clear = async () => {};
    chromeStub.action = { setBadgeText() {}, setBadgeBackgroundColor() {} };
    chromeStub.storage.session.set = async () => { storageSets++; };
    const sid = "ghost-tabs-create";
    S.sessions.set(sid, { state: "pending", reason: "t", createdAt: Date.now(), via: "tap" });
    let threw = "";
    try { await sandbox.allowSession(sid, "standing-grant"); } catch (e) { threw = String((e && e.message) || e); }
    t("tabs.create failure: allowSession does not throw", threw === "", threw);
    t("tabs.create failure: pending entry deleted (no ghost)", !S.sessions.has(sid));
    t("tabs.create failure: persistSessions ran", storageSets > 0, `session.set calls=${storageSets}`);
    chromeStub.tabs.create = keep.create; chromeStub.tabs.remove = keep.remove;
    chromeStub.runtime.getURL = keep.getURL; chromeStub.notifications.clear = keep.clear;
    chromeStub.action = keep.action; chromeStub.storage.session.set = keep.sessSet;
    S.sessions.delete(sid);
  }

  // 12. chrome.debugger.attach failure -> pending entry deleted + persisted.
  // Pre-fix failure mode: the dead tab's pending entry lingered as a ghost
  // (and the tab was never removed).
  {
    const keep = {
      create: chromeStub.tabs.create, remove: chromeStub.tabs.remove,
      attach: chromeStub.debugger.attach, getURL: chromeStub.runtime.getURL,
      clear: chromeStub.notifications.clear, action: chromeStub.action,
      sessSet: chromeStub.storage.session.set,
    };
    let storageSets = 0, removed = [];
    chromeStub.tabs.create = async () => ({ id: 4242 });
    chromeStub.tabs.remove = async (id) => { removed.push(id); };
    chromeStub.debugger.attach = async () => { throw new Error("boom: attach failed"); };
    chromeStub.runtime.getURL = (p) => "chrome-extension://test/" + p;
    chromeStub.notifications.clear = async () => {};
    chromeStub.action = { setBadgeText() {}, setBadgeBackgroundColor() {} };
    chromeStub.storage.session.set = async () => { storageSets++; };
    const sid = "ghost-attach";
    S.sessions.set(sid, { state: "pending", reason: "t", createdAt: Date.now(), via: "tap" });
    let threw = "";
    try { await sandbox.startSession(sid, "t", "standing-grant"); } catch (e) { threw = String((e && e.message) || e); }
    t("attach failure: startSession does not throw", threw === "", threw);
    t("attach failure: pending entry deleted (no ghost)", !S.sessions.has(sid));
    t("attach failure: persistSessions ran", storageSets > 0, `session.set calls=${storageSets}`);
    t("attach failure: dead tab removed", removed.includes(4242), JSON.stringify(removed));
    chromeStub.tabs.create = keep.create; chromeStub.tabs.remove = keep.remove;
    chromeStub.debugger.attach = keep.attach; chromeStub.runtime.getURL = keep.getURL;
    chromeStub.notifications.clear = keep.clear; chromeStub.action = keep.action;
    chromeStub.storage.session.set = keep.sessSet;
    S.sessions.delete(sid);
  }

  // 13. charCode()/key-code mapping via press_key CDP traffic. charCode() is
  // nested inside runAction, so assert its observable output: the DOM `code`
  // on the rawKeyDown event. Pre-fix failure mode: wrong codes (e.g. every
  // char sent as Unidentified) break typing in real pages.
  {
    const cases = [["a", "KeyA"], ["1", "Digit1"], [" ", "Space"],
      ["-", "Minus"], ["=", "Equal"], [";", "Semicolon"]];
    const ksess = { tabId: 7, elements: [], viewport: { w: 1280, h: 800 }, lastIndexAt: 0 };
    S.sessions.set("test-sess", ksess);
    for (const [key, code] of cases) {
      keyEvents.length = 0;
      await runAction(7, ksess, { type: "press_key", key });
      const down = keyEvents.find((e) => e.type === "rawKeyDown");
      t(`press_key ${JSON.stringify(key)} -> code ${code}`, !!down && down.code === code, JSON.stringify(down));
    }
  }

  // 14. outbox ordering (REGRESSION for the real v0.1.9 bug: flushOutbox ran
  // BEFORE hello in ws.onopen, so queued messages hit the relay pre-auth and
  // the socket was closed 4003). Messages queued while CONNECTING must be
  // held; on open, hello goes FIRST and the outbox flushes AFTER it.
  {
    const sent = [];
    const mockWs = { readyState: sandbox.WebSocket.CONNECTING, send(s) { sent.push(JSON.parse(s)); }, close() {} };
    const keepWs = S.ws, keepReady = S.wsReady, keepOutbox = S.outbox;
    S.ws = mockWs; S.wsReady = false; S.outbox = [];
    sandbox.sendMsg({ type: "action_result", id: "q1" });
    sandbox.sendMsg({ type: "event", kind: "x" });
    t("outbox holds messages while CONNECTING", sent.length === 0 && S.outbox.length === 2,
      `sent=${sent.length} outbox=${S.outbox.length}`);
    // simulate the real ws.onopen order: hello via sendMsg on the OPEN socket, then flush
    mockWs.readyState = sandbox.WebSocket.OPEN; S.wsReady = true;
    sandbox.sendMsg({ type: "hello", deviceToken: "t" });
    sandbox.flushOutbox();
    const types = sent.map((m) => m.type);
    t("hello sent FIRST, outbox flushed AFTER hello",
      types.length === 3 && types[0] === "hello" && sent[1].id === "q1",
      JSON.stringify(types));
    // static pin: the real ws.onopen in sw.js must send hello before flushOutbox()
    // (pre-fix v0.1.8 source had flushOutbox() first -> this assertion failed there)
    const onopenIdx = src.indexOf("ws.onopen");
    const helloIdx = src.indexOf('type: "hello"', onopenIdx);
    const flushIdx = src.indexOf("flushOutbox()", onopenIdx);
    t("sw.js ws.onopen orders hello before flushOutbox()",
      onopenIdx >= 0 && helloIdx > onopenIdx && flushIdx > helloIdx,
      `onopen=${onopenIdx} hello=${helloIdx} flush=${flushIdx}`);
    S.ws = keepWs; S.wsReady = keepReady; S.outbox = keepOutbox || [];
  }

  // 15. outbox cap: the 51st queued message must not grow the outbox past 50
  // (current code rejects it with a warning). Pre-fix failure mode: unbounded
  // growth while the socket sat in CONNECTING.
  {
    const mockWs = { readyState: sandbox.WebSocket.CONNECTING, send() {}, close() {} };
    const keepWs = S.ws, keepReady = S.wsReady, keepOutbox = S.outbox;
    S.ws = mockWs; S.wsReady = false; S.outbox = [];
    for (let i = 0; i < 51; i++) sandbox.sendMsg({ type: "event", n: i });
    t("outbox capped at 50 entries", S.outbox.length === 50, `len=${S.outbox.length}`);
    S.ws = keepWs; S.wsReady = keepReady; S.outbox = keepOutbox || [];
  }

  // 16. welcome-reconcile (REGRESSION for the live 2026-10-01 relay-restart
  // defect): the relay restarted, forgot all sessions, and sent welcome with
  // sessions: []. The extension must end its locally-active session that the
  // relay no longer knows: remove it, detach debugger, close the tab, clear
  // the badge, and report session_ended. Pre-fix failure mode (observed
  // live): no session_ended event reached the relay and the orphaned session
  // lingered.
  {
    const keep = {
      detach: chromeStub.debugger.detach, remove: chromeStub.tabs.remove,
      badge: chromeStub.action.setBadgeText, sendMessage: chromeStub.tabs.sendMessage,
      ws: S.ws, wsReady: S.wsReady,
    };
    const sent = [];
    const mockWs = { readyState: sandbox.WebSocket.OPEN, send: (d) => sent.push(JSON.parse(d)), close() {} };
    S.ws = mockWs; S.wsReady = true;
    const detached = [], removedTabs = [];
    let badgeCleared = false;
    chromeStub.debugger.detach = async () => { detached.push(1); };
    chromeStub.tabs.remove = async (id) => { removedTabs.push(id); };
    chromeStub.tabs.sendMessage = (id, msg, cb) => { cb({ ok: true }); };
    chromeStub.action.setBadgeText = () => { badgeCleared = true; };
    const sid = "orphan-after-relay-restart";
    S.sessions.set(sid, { state: "active", tabId: 9911, reason: "t", createdAt: Date.now(), via: "standing-grant" });
    await sandbox.handleRelayMessage({ type: "welcome", browserId: "b1", sessions: [] });
    t("welcome-reconcile: orphan session removed locally", !S.sessions.has(sid));
    t("welcome-reconcile: debugger detached", detached.length === 1, `n=${detached.length}`);
    t("welcome-reconcile: session tab closed", removedTabs.includes(9911), JSON.stringify(removedTabs));
    t("welcome-reconcile: badge cleared", badgeCleared === true);
    const ended = sent.find((m) => m.type === "event" && m.kind === "session_ended" && m.sessionId === sid);
    t("welcome-reconcile: session_ended event sent to relay", !!ended, JSON.stringify(sent.map((m) => m.kind || m.type)));
    // a session the relay DOES know must survive the same welcome
    const sid2 = "survivor";
    S.sessions.set(sid2, { state: "active", tabId: 9922, reason: "t", createdAt: Date.now(), via: "standing-grant" });
    await sandbox.handleRelayMessage({ type: "welcome", browserId: "b1", sessions: [sid2] });
    t("welcome-reconcile: known session survives", S.sessions.has(sid2));
    S.sessions.delete(sid2);
    chromeStub.debugger.detach = keep.detach; chromeStub.tabs.remove = keep.remove;
    chromeStub.action.setBadgeText = keep.badge; chromeStub.tabs.sendMessage = keep.sendMessage;
    S.ws = keep.ws; S.wsReady = keep.wsReady;
  }

  // 17. SW-termination survival (REGRESSION for the live 2026-10-01 relay-
  // restart defect): the relay restarted, the extension's SW was terminated
  // during the disconnect, and on wake its hello reported activeSessions: []
  // even though a session was active. Root cause hypothesis: restoreSessions
  // does not bring the session back. This test persists a session, wipes
  // S.sessions (simulating SW termination), runs restoreSessions, and
  // asserts the active session is restored (so the next hello reports it
  // and the welcome-reconcile can end it).
  {
    // functional storage.session mock: actually retains what persist writes
    const keepSess = chromeStub.storage.session;
    let stored = {};
    chromeStub.storage.session = {
      get: async () => ({ companionSessions: stored.companionSessions }),
      set: async (v) => { stored = { ...stored, ...v }; },
    };
    const sid = "survive-sw-restart";
    S.sessions.set(sid, { state: "active", tabId: 9933, reason: "t", createdAt: Date.now(), via: "standing-grant" });
    await sandbox.persistSessions();
    t("persistSessions: session written to storage.session", !!(stored.companionSessions && stored.companionSessions.sessions && stored.companionSessions.sessions[sid]),
      JSON.stringify(Object.keys((stored.companionSessions && stored.companionSessions.sessions) || {})));
    // simulate SW termination: wipe in-memory state
    S.sessions.clear();
    S.pendingConsent.clear();
    await sandbox.restoreSessions();
    const restored = S.sessions.get(sid);
    t("restoreSessions: active session restored after SW termination", !!restored && restored.state === "active",
      restored ? `state=${restored.state} tabId=${restored.tabId}` : "missing");
    t("restoreSessions: restored session keeps its tabId", !!restored && restored.tabId === 9933,
      restored ? `tabId=${restored.tabId}` : "missing");
    S.sessions.delete(sid);
    chromeStub.storage.session = keepSess;
  }

  // 18. endSession is fail-safe: if chrome.action.setBadgeText throws, the
  // session_ended event must still reach the relay. Pre-fix failure mode
  // (observed live 2026-10-01): the throw skipped sendMsg, so orphans
  // survived relay restarts with no event and no cleanup signal.
  {
    const keep = {
      badge: chromeStub.action.setBadgeText, detach: chromeStub.debugger.detach,
      remove: chromeStub.tabs.remove, sendMessage: chromeStub.tabs.sendMessage,
      ws: S.ws, wsReady: S.wsReady,
    };
    const sent = [];
    S.ws = { readyState: sandbox.WebSocket.OPEN, send: (d) => sent.push(JSON.parse(d)), close() {} };
    S.wsReady = true;
    chromeStub.action.setBadgeText = () => { throw new Error("boom: badge failed"); };
    chromeStub.debugger.detach = async () => {};
    chromeStub.tabs.remove = async () => {};
    chromeStub.tabs.sendMessage = (id, msg, cb) => { cb({ ok: true }); };
    const sid = "badge-throw";
    S.sessions.set(sid, { state: "active", tabId: 9944, reason: "t", createdAt: Date.now(), via: "standing-grant" });
    let threw = "";
    try { await sandbox.handleRelayMessage({ type: "session_end", sessionId: sid, reason: "test" }); } catch (e) { threw = String((e && e.message) || e); }
    t("endSession: badge throw does not propagate", threw === "", threw);
    t("endSession: session removed despite badge throw", !S.sessions.has(sid));
    const ended = sent.find((m) => m.type === "event" && m.kind === "session_ended" && m.sessionId === sid);
    t("endSession: session_ended event still sent", !!ended, JSON.stringify(sent.map((m) => m.kind || m.type)));
    chromeStub.action.setBadgeText = keep.badge; chromeStub.debugger.detach = keep.detach;
    chromeStub.tabs.remove = keep.remove; chromeStub.tabs.sendMessage = keep.sendMessage;
    S.ws = keep.ws; S.wsReady = keep.wsReady;
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} sw.js tests passed`);
  if (failed.length) process.exit(1);
  console.log("ALL SW.JS TESTS PASSED");
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
