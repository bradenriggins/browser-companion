/* Browser Companion - service worker (MV3 module)
 * Owns: relay WebSocket, sessions + consent, CDP control of the session tab,
 * indexed-DOM snapshots, action dispatch. No Manus code is used here.
 */

const TAG = "[Companion]";
const DEFAULT_RELAY = "ws://127.0.0.1:18791"; // default relay address; point this at your own relay server
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const ACTION_TIMEOUT_MS = 45000;
const CONSENT_TIMEOUT_MS = 60000;

// ---------- tiny storage layer ----------
const store = {
  async get(keys) { return chrome.storage.local.get(keys); },
  async set(obj) { return chrome.storage.local.set(obj); },
};

// ---------- logging ----------
function log(level, ...args) {
  if (level === "debug") console.debug(TAG, ...args);
  else if (level === "warn") console.warn(TAG, ...args);
  else console.log(TAG, ...args);
}

// ---------- utils ----------
const rand = (n) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const ADJECTIVES = ["Swift", "Bright", "Quick", "Cosmic", "Quantum", "Radiant", "Nova", "Turbo", "Mighty", "Noble"];
const ANIMALS = ["Fox", "Eagle", "Falcon", "Phoenix", "Dragon", "Voyager", "Ranger", "Hawk", "Wolf", "Comet"];
const pick = (l) => l[Math.floor(Math.random() * l.length)];
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// ---------- state ----------
const S = {
  ws: null,
  wsReady: false,
  clientId: null,
  browserId: null,
  browserName: null,
  relayUrl: DEFAULT_RELAY,
  sessions: new Map(), // sessionId -> {tabId, state, reason, expiresAt, paused, createdAt}
  pendingConsent: new Map(), // sessionId -> {timer, expiresAt}
  actionCache: new Map(), // actionId -> result (idempotency)
  reconnectDelay: RECONNECT_BASE_MS,
};

async function loadConfig() {
  const c = await store.get(["deviceToken", "browserName", "relayUrl", "clientId", "browserId", "alwaysAllow"]);
  S.relayUrl = c.relayUrl || DEFAULT_RELAY;
  S.browserName = c.browserName || `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
  S.clientId = c.clientId || rand(8);
  S.browserId = c.browserId || null;
  await store.set({ browserName: S.browserName, clientId: S.clientId });
  return c;
}

// ---------- session persistence across SW restarts ----------
// MV3 suspends this worker after ~30s idle; in-memory sessions would vanish,
// orphaning the relay's view and stranding consent timeouts. Persist the small
// session records to chrome.storage.session (survives SW restarts, cleared on
// browser close, which is the right lifetime: tabs die with the browser).
const sessStore = {
  async get() { try { return await chrome.storage.session.get(["companionSessions"]); } catch { return {}; } },
  async set(v) { try { await chrome.storage.session.set({ companionSessions: v }); } catch (e) { log("warn", "persist failed", e.message); } },
};
async function persistSessions() {
  const sessions = {};
  for (const [id, s] of S.sessions) {
    if (s.state === "pending" || s.state === "active")
      sessions[id] = { tabId: s.tabId, state: s.state, reason: s.reason, mode: s.mode, paused: !!s.paused, createdAt: s.createdAt };
  }
  const pending = {};
  for (const [id, t] of S.pendingConsent) pending[id] = t.expiresAt;
  await sessStore.set({ sessions, pending });
}
async function restoreSessions() {
  const data = (await sessStore.get()).companionSessions;
  if (!data) return;
  const now = Date.now();
  for (const [id, s] of Object.entries(data.sessions || {})) {
    if (s.state === "pending") {
      const expiresAt = (data.pending || {})[id] || 0;
      if (expiresAt && expiresAt <= now) continue; // already expired; relay sweeper ends it
      S.sessions.set(id, { ...s, elements: [], lastIndexAt: 0 });
      armConsentTimeout(id, Math.max(1000, expiresAt - now));
    } else if (s.state === "active") {
      S.sessions.set(id, { ...s, elements: [], lastIndexAt: 0 });
      // page still has its banner (SW restart does not reload the tab); re-assert to be sure
      setMask(s.tabId, s.paused ? "takeover" : "ongoing").catch(() => {});
    }
  }
  if (S.sessions.size) log("log", "restored", S.sessions.size, "sessions after SW restart");
}
function armConsentTimeout(sessionId, ms) {
  const old = S.pendingConsent.get(sessionId);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => denySession(sessionId, "consent timeout"), ms);
  S.pendingConsent.set(sessionId, { timer, expiresAt: Date.now() + ms });
  persistSessions();
}

// ---------- relay socket ----------
// Outbox for the brief CONNECTING window: dropping an action_result there
// would leave the agent hanging until the relay's 45s timeout. Messages
// queue while connecting and flush on open; if the socket is closed/dead
// they are still dropped (the relay fail-fast rejects pending actions).
function sendMsg(obj) {
  if (S.ws && S.wsReady) { S.ws.send(JSON.stringify(obj)); return; }
  if (S.ws && S.ws.readyState === WebSocket.CONNECTING) {
    S.outbox = S.outbox || [];
    if (S.outbox.length < 50) S.outbox.push(obj);
    else log("warn", "outbox full, dropping", obj.type);
    return;
  }
  log("warn", "socket not ready, dropping", obj.type);
}

function flushOutbox() {
  if (!S.outbox || !S.outbox.length) return;
  const n = S.outbox.length;
  for (const obj of S.outbox) { try { S.ws.send(JSON.stringify(obj)); } catch (e) { log("warn", "outbox flush failed", obj.type); break; } }
  S.outbox = [];
  log("log", "flushed outbox", n, "messages");
}

function connectRelay() {
  loadConfig().then((cfg) => {
    if (!cfg.deviceToken) { log("log", "not paired yet; skipping connect"); return; }
    if (S.ws && (S.ws.readyState === WebSocket.OPEN || S.ws.readyState === WebSocket.CONNECTING)) return;
    log("log", "connecting to", S.relayUrl);
    const ws = new WebSocket(S.relayUrl);
    S.ws = ws;
    ws.onopen = () => {
      S.wsReady = true;
      S.reconnectDelay = RECONNECT_BASE_MS;
      sendMsg({
        type: "hello", deviceToken: cfg.deviceToken, clientId: S.clientId,
        browserId: S.browserId, browserName: S.browserName,
        ua: navigator.userAgent, version: chrome.runtime.getManifest().version,
        capabilities: ["view", "navigate", "click", "input", "scroll", "press_key",
          "select_option", "move_mouse", "find_keyword", "upload_file",
          "list_downloads", "list_resources", "download_resource"],
        // session reconciliation: tell the relay which sessions we still hold
        // after a possible SW restart, so it can end the ones we lost
        activeSessions: [...S.sessions.entries()]
          .filter(([, s]) => s.state === "active" || s.state === "pending")
          .map(([id]) => id),
      });
      // flush only AFTER hello: the relay closes pre-auth messages (4003)
      flushOutbox();
    };
    ws.onmessage = (ev) => handleRelayMessage(JSON.parse(ev.data)).catch((e) => log("warn", "relay msg failed", e));
    ws.onclose = () => {
      S.wsReady = false;
      log("warn", "socket closed; reconnect in", S.reconnectDelay, "ms");
      setTimeout(connectRelay, S.reconnectDelay);
      S.reconnectDelay = Math.min(S.reconnectDelay * 2, RECONNECT_MAX_MS);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  });
}

async function handleRelayMessage(msg) {
  switch (msg.type) {
    case "welcome":
      S.browserId = msg.browserId;
      await store.set({ browserId: msg.browserId });
      log("log", "paired as browser", msg.browserId);
      // reconcile: end any restored session the relay no longer knows
      if (Array.isArray(msg.sessions)) {
        for (const [id, s] of [...S.sessions]) {
          if ((s.state === "active" || s.state === "pending") && !msg.sessions.includes(id)) {
            log("warn", "session", id, "unknown to relay after restart; ending locally");
            await endSession(id, "relay lost session across restart");
          }
        }
      }
      break;
    case "ping":
      sendMsg({ type: "pong", id: msg.id });
      break;
    case "session_request":
      await onSessionRequest(msg);
      break;
    case "action":
      await onAction(msg);
      break;
    case "session_end":
      await endSession(msg.sessionId, msg.reason || "relay ended session");
      break;
    default:
      log("warn", "unknown relay message", msg.type);
  }
}

// ---------- sessions & consent ----------
async function onSessionRequest(msg) {
  const { sessionId, reason } = msg;
  log("log", "session requested", sessionId, reason);
  const cfg = await loadConfig();
  if (cfg.alwaysAllow !== false) {
    // Standing grant: user paired once and wants no per-session taps.
    // The tab banner with Take over / Stop still shows for every session,
    // and the grant is visible and revocable in the popup.
    S.sessions.set(sessionId, { state: "pending", reason, createdAt: Date.now(), via: "standing-grant" });
    persistSessions();
    await allowSession(sessionId, "standing-grant");
    return;
  }
  // Per-session tap path: no auto-allow, no remembered consent.
  S.sessions.set(sessionId, { state: "pending", reason, createdAt: Date.now(), via: "tap" });
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
  // Pop the consent UI open where it can't be missed. macOS can suppress
  // extension notifications silently, so the popup is the primary surface
  // and the OS notification below is the fallback.
  try {
    await chrome.action.openPopup();
  } catch (e) {
    log("warn", "openPopup failed; consent relies on notification", String((e && e.message) || e));
  }
  chrome.notifications.create(`consent-${sessionId}`, {
    type: "basic", iconUrl: "icons/icon48.png",
    title: "Browser Companion wants to drive a browser tab",
    message: `${reason}\n\nClick Allow once, or open the Companion popup for more options. Auto-denies in 60s.`,
    buttons: [{ title: "Allow once" }, { title: "Deny" }],
    requireInteraction: true,
  });
  armConsentTimeout(sessionId, CONSENT_TIMEOUT_MS);
  sendMsg({ type: "event", kind: "session_consent", sessionId, state: "pending" });
  persistSessions();
}

async function allowSession(sessionId, mode) {
  const s = S.sessions.get(sessionId);
  if (!s || s.state !== "pending") return; // already decided; never double-start a tab
  const t = S.pendingConsent.get(sessionId);
  if (t) { clearTimeout(t.timer); S.pendingConsent.delete(sessionId); }
  chrome.notifications.clear(`consent-${sessionId}`).catch(() => {});
  chrome.action.setBadgeText({ text: "" });
  try {
    await startSession(sessionId, s.reason || "", mode);
  } catch (e) {
    // tab creation itself failed: don't leave a ghost pending session
    S.sessions.delete(sessionId);
    sendMsg({ type: "event", kind: "session_consent", sessionId, state: "error", reason: String((e && e.message) || e) });
    log("warn", "session failed to start", sessionId, String((e && e.message) || e));
  }
  persistSessions();
}

async function denySession(sessionId, why) {
  const s = S.sessions.get(sessionId);
  if (!s || s.state !== "pending") return; // already decided
  const t = S.pendingConsent.get(sessionId);
  if (t) { clearTimeout(t.timer); S.pendingConsent.delete(sessionId); }
  chrome.notifications.clear(`consent-${sessionId}`).catch(() => {});
  chrome.action.setBadgeText({ text: "" });
  S.sessions.delete(sessionId);
  persistSessions();
  sendMsg({ type: "event", kind: "session_consent", sessionId, state: "denied", reason: why });
  log("log", "session denied", sessionId, why);
}

async function startSession(sessionId, reason, mode) {
  // Dedicated tab in its own group. The tab opens the bundled start page,
  // which runs the companion script natively. about:blank is not an option:
  // the platform hard-blocks scripting.executeScript into top-level
  // about:blank tabs (proven by probe 2026-10-01), which made session start
  // fail closed on the banner.
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("src/session.html"), active: false });
  let groupId = null;
  try {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: "Companion", color: "yellow", collapsed: false });
  } catch (e) { log("warn", "tab group failed", e); }
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    // clean up the pending entry so it can't linger as a ghost session
    S.sessions.delete(sessionId);
    persistSessions();
    sendMsg({ type: "event", kind: "session_consent", sessionId, state: "error", reason: String(e) });
    return;
  }
  S.sessions.set(sessionId, {
    state: "active", tabId: tab.id, groupId, reason, mode,
    paused: false, createdAt: Date.now(), lastIndexAt: 0, elements: [],
  });
  // fail closed on visibility: never drive a tab the user can't see is driven
  const maskOk = await setMask(tab.id, "ongoing");
  if (!maskOk) {
    S.sessions.delete(sessionId);
    persistSessions();
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    sendMsg({ type: "event", kind: "session_consent", sessionId, state: "error", reason: "could not show the session banner; session aborted" });
    log("warn", "session aborted: mask failed", sessionId);
    return;
  }
  sendMsg({ type: "event", kind: "session_consent", sessionId, state: "active", tabId: tab.id, via: mode });
  log("log", "session active", sessionId, "tab", tab.id, "mode", mode);
  persistSessions();
}

async function endSession(sessionId, reason) {
  const s = S.sessions.get(sessionId);
  if (!s || s.ending) return; // idempotent: debugger onDetach re-fires after our own detach
  s.ending = true;
  S.sessions.delete(sessionId);
  const t = S.pendingConsent.get(sessionId);
  if (t) { clearTimeout(t.timer); S.pendingConsent.delete(sessionId); }
  // Send the event FIRST, synchronously: live-proven 2026-10-01 that the
  // socket can be disrupted during the async cleanup below (the event was
  // dropped while a debug event sent just before endSession arrived fine).
  // The relay must know the session ended even if local cleanup throws.
  try { sendMsg({ type: "event", kind: "session_ended", sessionId, reason }); } catch (e) { log("warn", "session_ended send failed", e.message); }
  // Every step below is guarded: local cleanup must not throw.
  if (s?.tabId) {
    await setMask(s.tabId, "idle").catch(() => {});
    await chrome.debugger.detach({ tabId: s.tabId }).catch(() => {});
    await chrome.tabs.remove(s.tabId).catch(() => {});
  }
  try { chrome.action.setBadgeText({ text: "" }); } catch {}
  log("log", "session ended", sessionId, reason);
  try { await persistSessions(); } catch {}
}

// ---------- content-script bridge ----------
async function sendToTab(tabId, msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("content script timeout")), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      clearTimeout(to);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

async function ensureContentScript(tabId) {
  // The companion script loads natively in session tabs (bundled start page)
  // and on http(s) pages (manifest content_scripts); poll for it before the
  // programmatic fallback. Never rely on injecting into about:blank: the
  // platform hard-blocks scripting there even with <all_urls> host permission.
  for (let i = 0; i < 12; i++) {
    try { await sendToTab(tabId, { type: "ping" }, 700); return; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
  await sendToTab(tabId, { type: "ping" }, 8000);
}

async function setMask(tabId, state) {
  // returns true when the banner took; callers that REQUIRE visibility fail closed
  try {
    await ensureContentScript(tabId);
    const r = await sendToTab(tabId, { type: "mask", state }, 4000);
    return r?.ok === true;
  } catch (e) { log("warn", "mask failed", e.message); return false; }
}

// ---------- CDP helpers ----------
function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function screenshot(tabId) {
  const { data } = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
  return data;
}

// Build a paint-order-sorted index of interactive elements via DOMSnapshot.
async function captureIndex(tabId) {
  const s = S.sessions.get([...S.sessions.keys()].find((k) => S.sessions.get(k).tabId === tabId));
  try {
    await cdp(tabId, "DOM.enable", {});
    let snap = null;
    try {
      snap = await Promise.race([
        cdp(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true, includePaintOrder: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("snapshot timeout")), 5000)),
      ]);
    } catch (e) { log("warn", "DOMSnapshot failed, JS fallback", e.message); }
    let elements = [];
    // DOMSnapshot layout bounds come back in device pixels; normalize to CSS px
    // (the space Input.dispatchMouseEvent expects) via the page's devicePixelRatio.
    let dpr = 1, viewport = null;
    try {
      const ev = await cdp(tabId, "Runtime.evaluate", {
        expression: "({dpr: window.devicePixelRatio || 1, w: window.innerWidth || 0, h: window.innerHeight || 0})",
        returnByValue: true,
      });
      const v = ev?.result?.value;
      if (v) { dpr = v.dpr > 0 ? v.dpr : 1; viewport = { w: v.w, h: v.h }; }
    } catch {}
    if (snap?.documents?.length) elements = elementsFromSnapshot(snap, dpr);
    else {
      // content script returns {ok, elements}; unwrap, the SW must hold the bare array
      const r = await sendToTab(tabId, { type: "index" });
      elements = r?.elements || [];
    }
    if (s) { s.elements = elements; s.lastIndexAt = Date.now(); if (viewport) s.viewport = viewport; }
    try { await sendToTab(tabId, { type: "setIndex", elements }); } catch (e) { log("warn", "setIndex push failed", e.message); }
    return elements;
  } catch (e) {
    log("warn", "captureIndex failed", e.message);
    return s?.elements || [];
  }
}

function strOf(strings, idx) { return idx >= 0 && idx < strings.length ? strings[idx] : ""; }

function elementsFromSnapshot(snap, dpr) {
  const out = [];
  const { strings } = snap;
  const CLICKABLE_ROLES = new Set(["button", "link", "checkbox", "radio", "textbox", "combobox", "menuitem", "tab", "switch"]);
  for (const doc of snap.documents) {
    const { nodes, layout } = doc;
    if (!nodes || !layout) continue;
    const { backendNodeId, nodeType, nodeName, attributes } = nodes;
    const { nodeIndex, bounds } = layout;
    // map parent element -> first text child, so links/buttons get visible names
    const textByParent = new Map();
    for (let k = 0; k < nodeIndex.length; k++) {
      const ni = nodeIndex[k];
      if (nodes.nodeType[ni] !== 3) continue; // text nodes only
      const t = strOf(strings, nodes.textValue ? nodes.textValue[ni] : -1).trim().replace(/\s+/g, " ");
      if (!t) continue;
      const parent = nodes.parentIndex ? nodes.parentIndex[ni] : -1;
      if (parent >= 0 && !textByParent.has(parent)) textByParent.set(parent, t.slice(0, 80));
    }
    const items = [];
    for (let k = 0; k < nodeIndex.length; k++) {
      const ni = nodeIndex[k];
      if (nodes.nodeType[ni] !== 1) continue; // elements only
      const tag = strOf(strings, nodes.nodeName[ni]).toLowerCase();
      const b = bounds[k]; // [x, y, w, h] in device px; normalized to CSS px below
      if (!b || b[2] < 2 * dpr || b[3] < 2 * dpr) continue;
      // visibility: skip offscreen-ish and zero-area
      const attrs = {};
      const ai = nodes.attributes[ni] || [];
      for (let a = 0; a < ai.length; a += 2) attrs[strOf(strings, ai[a]).toLowerCase()] = strOf(strings, ai[a + 1]);
      const role = (attrs.role || implicitRole(tag, attrs)).toLowerCase();
      const name = (attrs["aria-label"] || attrs.value || attrs.placeholder || attrs.title || attrs.alt || textByParent.get(ni) || "").slice(0, 80);
      const clickable = CLICKABLE_ROLES.has(role) || tag === "a" || tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || attrs.onclick !== undefined || attrs.href !== undefined;
      const editable = tag === "input" || tag === "textarea" || attrs.contenteditable === "true";
      if (!clickable && !editable) continue;
      items.push({
        tag, role, name,
        x: Math.round(b[0] / dpr), y: Math.round(b[1] / dpr),
        w: Math.round(b[2] / dpr), h: Math.round(b[3] / dpr),
        paint: layout.paintOrders ? layout.paintOrders[k] : 0,
        backendId: nodes.backendNodeId[ni],
        hash: hashStr(`${tag}|${role}|${name}|${Math.round(b[0] / (4 * dpr))}|${Math.round(b[1] / (4 * dpr))}`),
      });
    }
    items.sort((a, b2) => (a.paint ?? 1e9) - (b2.paint ?? 1e9) || a.y - b2.y || a.x - b2.x);
    items.forEach((el, i) => { el.i = out.length + i; });
    out.push(...items);
  }
  return out.slice(0, 400);
}

function implicitRole(tag, attrs) {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return { text: "textbox", checkbox: "checkbox", radio: "radio", submit: "button", button: "button" }[attrs.type] || "textbox";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  return "generic";
}

async function collectArtifacts(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const elements = await captureIndex(tabId);
  const shot = await screenshot(tabId).catch(() => null);
  return {
    url: tab.url, title: tab.title,
    viewport: { w: tab.width, h: tab.height },
    screenshot: shot,
    elements: elements.map(({ i, role, name, x, y, w, h, hash }) => ({ i, role, name, x, y, w, h, hash })),
  };
}

function findElement(session, target) {
  if (target.strategy !== "byIndex") throw new Error(`unsupported target strategy ${target.strategy}`);
  const els = session.elements || [];
  // Hashes may be passed truncated for display; accept either direction of prefix match.
  const hashEq = (a, b) => a && b && (a === b || a.startsWith(b) || b.startsWith(a));
  let el = els.find((e) => e.i === target.index);
  if (el && target.hash && !hashEq(el.hash, target.hash)) el = null; // index shuffled; relocate below
  if (!el && target.hash) {
    const matches = els.filter((e) => hashEq(e.hash, target.hash));
    const exact = matches.find((e) => e.hash === target.hash);
    if (exact) el = exact;
    else if (matches.length === 1) el = matches[0];
    // never guess between several prefix matches; the agent must re-view for exact hashes
    else if (matches.length > 1) throw new Error(`ambiguous target hash ${target.hash}: matches elements ${matches.map((m) => m.i).join(",")}; re-view for exact hashes`);
  }
  if (!el) throw new Error(target.hash
    ? `element ${target.index} changed since snapshot (stale index)`
    : `no element with index ${target.index}`);
  return el;
}

// ---------- actions ----------
// per-session action queue: CDP on one tab must not interleave, so actions
// for the same session run strictly one at a time
const actionQueues = new Map(); // sessionId -> tail promise
async function onAction(msg) {
  const { id, sessionId, action } = msg;
  if (S.actionCache.has(action.actionId || id)) {
    const cached = S.actionCache.get(action.actionId || id);
    sendMsg({ type: "action_result", id, sessionId, cached: true, ...cached });
    return;
  }
  const prev = actionQueues.get(sessionId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => runActionGuarded(sessionId, action));
  actionQueues.set(sessionId, run);
  const result = await run;
  if (actionQueues.get(sessionId) === run) actionQueues.delete(sessionId);
  cacheActionResult(action.actionId || id, result);
  // sessionId travels with every result so the relay (and agent) can attribute
  // it exactly; it must always equal the dispatched action's session.
  sendMsg({ type: "action_result", id, sessionId, ...result });
}

function cacheActionResult(key, result) {
  S.actionCache.set(key, result);
  // bound the cache: drop oldest past 50 entries
  if (S.actionCache.size > 50) S.actionCache.delete(S.actionCache.keys().next().value);
}

async function runActionGuarded(sessionId, action) {
  const session = S.sessions.get(sessionId);
  if (!session || session.state !== "active") return { status: "error", error: "no active session" };
  if (session.paused) return { status: "error", error: "session paused: user took over" };
  const tabId = session.tabId;
  try {
    const result = await runActionWithTimeout(tabId, session, action);
    return { status: "success", result };
  } catch (e) { return { status: "error", error: String(e?.message || e) }; }
}

function runActionWithTimeout(tabId, session, action) {
  return Promise.race([
    runAction(tabId, session, action),
    new Promise((_, rej) => setTimeout(() => rej(new Error("action timeout")), ACTION_TIMEOUT_MS)),
  ]);
}

async function freshIndex(tabId, session) {
  if (Date.now() - (session.lastIndexAt || 0) < 2000 && session.elements.length) return session.elements;
  return captureIndex(tabId);
}

async function runAction(tabId, session, a) {
  switch (a.type) {
    case "view": {
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: "current view captured", artifacts };
    }
    case "navigate": {
      // Web-only: never let the agent drive chrome://, file://, javascript:, or
      // other privileged schemes. Sessions start on the bundled session.html
      // page; navigation is http/https only.
      let proto;
      try { proto = new URL(a.url).protocol; } catch { throw new Error(`bad url: ${a.url}`); }
      if (proto !== "http:" && proto !== "https:") throw new Error(`refusing to navigate to non-web url (${proto})`);
      await chrome.tabs.update(tabId, { url: a.url });
      await waitForLoad(tabId);
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `navigated to ${a.url}`, artifacts };
    }
    case "click": {
      const els = await freshIndex(tabId, session);
      const el = findElement(session, a.target);
      // DOMSnapshot bounds are document-relative CSS px; Input.dispatchMouseEvent
      // and the viewport guard need client coords, so subtract the live scroll offset.
      let sx = 0, sy = 0;
      try {
        const sev = await cdp(tabId, "Runtime.evaluate", {
          expression: "({x: window.scrollX || 0, y: window.scrollY || 0})", returnByValue: true,
        });
        sx = sev?.result?.value?.x || 0; sy = sev?.result?.value?.y || 0;
      } catch {}
      const x = el.x + el.w / 2 - sx, y = el.y + el.h / 2 - sy;
      // Fail loudly instead of clicking empty space when the target is off-viewport
      // (e.g. coordinate-space mismatch); the agent should scroll or re-view first.
      const vp = session.viewport;
      if (vp && vp.w > 0 && (x < 0 || y < 0 || x > vp.w || y > vp.h))
        throw new Error(`element ${el.i} center (${Math.round(x)},${Math.round(y)}) is outside the ${vp.w}x${vp.h} viewport; scroll it into view first`);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      if (a.clickType === "double") {
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
        await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
      }
      await sleep(600);
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `clicked element ${el.i} (${el.role} ${el.name})`, artifacts };
    }
    case "input": {
      const els = await freshIndex(tabId, session);
      const el = findElement(session, a.target);
      await ensureContentScript(tabId);
      const r = await sendToTab(tabId, { type: "doInput", index: el.i, text: a.text, pressEnter: !!a.pressEnter });
      if (!r?.ok) throw new Error(r?.error || "input failed");
      await sleep(400);
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `typed into element ${el.i}`, artifacts };
    }
    case "scroll": {
      await ensureContentScript(tabId);
      const r = await sendToTab(tabId, {
        type: "doScroll", direction: a.direction, toEnd: !!a.toEnd,
        index: a.target?.strategy === "byIndex" ? a.target.index : undefined,
        x: a.x, y: a.y,
      });
      if (!r?.ok) throw new Error(r?.error || "scroll failed");
      await sleep(400);
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `scrolled ${a.direction || ""}`, artifacts };
    }
    case "press_key": {
      const key = a.key; // e.g. "Enter", "Tab", "Escape", "a"
      const isChar = key.length === 1;
      // Build a correct DOM `code` for single characters: letters get KeyX,
      // digits get DigitN, common symbols get their standard codes.
      function charCode(ch) {
        if (/^[a-zA-Z]$/.test(ch)) return `Key${ch.toUpperCase()}`;
        if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
        const sym = { " ": "Space", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", "`": "Backquote", ",": "Comma", ".": "Period", "/": "Slash" };
        return sym[ch] || "Unidentified";
      }
      if (isChar) {
        // proper text-event sequence: rawKeyDown, char (carries the text), keyUp
        const code = charCode(key);
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key, code });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: key, unmodifiedText: key });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code });
      } else {
        const code = { Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight" }[key] || key;
        const windowsVirtualKeyCode = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[key];
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
      }
      await sleep(300);
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `pressed ${key}`, artifacts };
    }
    case "select_option": {
      const els = await freshIndex(tabId, session);
      const el = findElement(session, a.target);
      await ensureContentScript(tabId);
      const r = await sendToTab(tabId, { type: "doSelect", index: el.i, value: a.value, label: a.label });
      if (!r?.ok) throw new Error(r?.error || "select failed");
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `selected option in element ${el.i}`, artifacts };
    }
    case "move_mouse": {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
      return { status: "success", message: `mouse moved to ${a.x},${a.y}` };
    }
    case "find_keyword": {
      await ensureContentScript(tabId);
      const r = await sendToTab(tabId, { type: "doFind", keyword: a.keyword });
      if (!r?.ok) throw new Error(r?.error || "find failed");
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `found "${a.keyword}" ${r.count} time(s)`, artifacts };
    }
    case "upload_file": {
      // v1: the file must already exist on the Mac; agent supplies the absolute path.
      const els = await freshIndex(tabId, session);
      const el = findElement(session, a.target);
      if (!Array.isArray(a.files) || !a.files.length) throw new Error("upload_file needs a non-empty files array");
      // DOM.resolveNode needs a CDP backendNodeId; elements from the JS fallback
      // index don't have one, so fail loudly instead of sending a bad resolve.
      if (el.backendId == null) throw new Error(`element ${el.i} came from the JS fallback index (no CDP node); re-view the page so DOMSnapshot can resolve it, then retry the upload`);
      // DOM.setFileInputFiles accepts backendNodeId directly: no resolveNode/
      // requestNode round trip needed (requestNode's objectId lookup proved
      // unreliable live: "Could not find node with given id").
      await cdp(tabId, "DOM.setFileInputFiles", { backendNodeId: el.backendId, files: a.files });
      const artifacts = await collectArtifacts(tabId);
      return { status: "success", message: `attached ${a.files.length} file(s)`, artifacts };
    }
    case "list_downloads": {
      const items = await chrome.downloads.search(a.query || {});
      return {
        status: "success",
        message: `${items.length} download(s)`,
        downloads: items.map((d) => ({
          id: d.id, filename: d.filename, url: d.url, finalUrl: d.finalUrl,
          state: d.state, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
          exists: d.exists, error: d.error || null,
        })),
      };
    }
    case "list_resources": {
      await ensureContentScript(tabId);
      const r = await sendToTab(tabId, { type: "doListResources" });
      if (!r?.ok) throw new Error(r?.error || "list_resources failed");
      return { status: "success", message: `${r.resources.length} resource(s)`, resources: r.resources };
    }
    case "download_resource":
    case "download_resources": {
      const url = a.url || a.resourceUrl;
      const idx = a.resourceIndex;
      let targetUrl = url;
      if (!targetUrl && idx !== undefined) {
        await ensureContentScript(tabId);
        const r = await sendToTab(tabId, { type: "doListResources" });
        const res = r?.resources?.[idx];
        if (!res) throw new Error(`resource index ${idx} not found; list_resources first`);
        targetUrl = res.url;
      }
      if (!targetUrl) throw new Error("download_resource needs url or resourceIndex (see list_resources)");
      const downloadId = await chrome.downloads.download({ url: targetUrl, saveAs: false });
      return { status: "success", message: `download started`, downloadId, url: targetUrl };
    }
    default:
      throw new Error(`unknown action type ${a.type}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForLoad(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("tab closed");
    if (tab.status === "complete") { await sleep(800); return; }
    await sleep(400);
  }
}

// ---------- tab lifecycle: fail-closed ----------
// Navigations wipe the page's JS world, including the mask overlay state.
// Re-assert the banner every time a session tab finishes loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const s = [...S.sessions.values()].find((x) => x.tabId === tabId && x.state === "active");
  if (s) setMask(tabId, s.paused ? "takeover" : "ongoing").catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sid, s] of S.sessions) {
    if (s.tabId === tabId && s.state === "active") {
      S.sessions.delete(sid);
      sendMsg({ type: "event", kind: "session_ended", sessionId: sid, reason: "tab closed by user" });
      log("log", "session", sid, "ended: tab closed");
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  for (const [sid, s] of S.sessions) {
    if (s.tabId === source.tabId && s.state === "active") {
      endSession(sid, "debugger detached").catch(() => {});
    }
  }
});

// ---------- messages from popup / content ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "getState": {
        const cfg = await loadConfig();
        sendResponse({
          paired: !!cfg.deviceToken, browserName: S.browserName,
          relayUrl: S.relayUrl,
          connected: S.wsReady, browserId: S.browserId,
          alwaysAllow: cfg.alwaysAllow !== false,
          sessions: [...S.sessions.entries()].map(([id, s]) => ({ id, ...s, elements: undefined })),
        });
        break;
      }
      case "setRelayUrl":
        await store.set({ relayUrl: msg.url });
        S.relayUrl = msg.url;
        if (S.ws) { try { S.ws.close(); } catch {} }
        connectRelay();
        sendResponse({ ok: true });
        break;
      case "setAlwaysAllow":
        await store.set({ alwaysAllow: !!msg.value });
        sendResponse({ ok: true, alwaysAllow: !!msg.value });
        break;
      case "pair": {
        // exchange pairing code for a device token
        const relayHttp = S.relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
        const res = await fetch(`${relayHttp}/pair`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: msg.code, browserName: S.browserName }),
        });
        if (!res.ok) throw new Error(`pairing failed: ${res.status}`);
        const data = await res.json();
        await store.set({ deviceToken: data.deviceToken, relayUrl: S.relayUrl, alwaysAllow: true });
        connectRelay();
        sendResponse({ ok: true, browserId: data.browserId });
        break;
      }
      case "unpair": {
        // revoke server-side first so the token can't hello again
        const cfg = await loadConfig();
        if (cfg.deviceToken) {
          const relayHttp = S.relayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
          await fetch(`${relayHttp}/revoke`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceToken: cfg.deviceToken }),
          }).catch(() => {});
        }
        await store.set({ deviceToken: null, browserId: null });
        S.browserId = null;
        if (S.ws) { try { S.ws.close(); } catch {} }
        sendResponse({ ok: true });
        break;
      }
      case "consent": // from popup: {sessionId, decision: "allow"|"deny"}
        // only extension pages (popup) may grant consent; content scripts carry sender.tab
        if (sender.tab) { sendResponse({ ok: false, error: "forbidden" }); break; }
        if (msg.decision === "deny") await denySession(msg.sessionId, "denied in popup");
        else await allowSession(msg.sessionId, "allow-once");
        sendResponse({ ok: true });
        break;
      case "stopSession":
        if (sender.tab) { sendResponse({ ok: false, error: "forbidden" }); break; }
        await endSession(msg.sessionId, "stopped from popup");
        sendResponse({ ok: true });
        break;
      case "takeover": { // from content script overlay
        const sid = [...S.sessions.entries()].find(([, s]) => s.tabId === sender.tab?.id)?.[0];
        if (sid) {
          S.sessions.get(sid).paused = msg.paused;
          await setMask(sender.tab.id, msg.paused ? "takeover" : "ongoing");
          persistSessions();
          sendMsg({ type: "event", kind: "takeover", sessionId: sid, paused: msg.paused });
        }
        sendResponse({ ok: true });
        break;
      }
      case "stopFromPage": { // overlay Stop button
        const sid = [...S.sessions.entries()].find(([, s]) => s.tabId === sender.tab?.id)?.[0];
        if (sid) await endSession(sid, "stopped by user on page");
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.notifications.onButtonClicked.addListener((id, btn) => {
  if (!id.startsWith("consent-")) return;
  const sessionId = id.slice("consent-".length);
  if (btn === 0) allowSession(sessionId, "allow-once");
  else denySession(sessionId, "denied via notification");
});

// keep-alive: MV3 may suspend us; alarms wake us to hold the socket
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive" && (!S.ws || S.ws.readyState === WebSocket.CLOSED)) connectRelay();
});

// boot: restore any sessions that survived an SW restart before connecting,
// so the hello carries the right activeSessions list for reconciliation
loadConfig().then(() => restoreSessions()).then(() => connectRelay());
log("log", "service worker started");
