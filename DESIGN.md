# Browser Companion - Design

A Manus-Browser-Operator-style extension, that lets your AI agent operate your real Chrome
instead of Manus. Clean-room implementation: no Manus code, protocol, or assets
reused - only the architectural ideas documented in MANUS-REVERSE-ENGINEERING.md.

## v0.1.10 changes (2026-10-01 VM lane: remaining tests + deeper gaps)
- Relay `POST /api/act` now runs a per-session FIFO queue: action N+1 is not
  dispatched until action N's result is recorded (resolved + audited). Actions
  for different sessions stay concurrent. (The extension already serialized
  per-session via its own actionQueues; the relay now does too, so dispatch
  order matches execution order even under concurrent agent requests.)
- Exact result correspondence: the extension's `action_result` carries
  `sessionId`; the relay only resolves when it matches the dispatched action's
  session (older extensions omit `sessionId` entirely, which still resolves),
  and every `/api/act` HTTP response carries the authoritative relay-issued
  `id` and `sessionId` so the agent attributes results exactly, never by order.
- Fixed: `/api/act`'s `b.ws.send` was unguarded (a mid-close throw escaped the
  promise executor and left a pending entry until the 45s timeout). Now caught,
  the pending entry is cleaned up, and an error result is returned + audited.
- Tests: sw-battery adds tabs.create/attach rollback, charCode mapping, outbox
  hello-first ordering + cap; relay-battery adds send-guard pins, oversized-
  frame 1009, FIFO ordering, correspondence, audit-field, socket-error, and
  revoke-cycle tests. Expired-pairing-code path is now actually exercised.

## v0.1.9 changes (2026-10-01 deep-verify pass 2 fix)
- Fixed: the v0.1.8 outbox flushed BEFORE hello in `ws.onopen`, so queued
  messages hit the relay pre-auth and the socket was closed 4003. Flush now
  runs AFTER the hello send (see CHECKPOINT.md "pass 2"). Live-proven:
  standing-grant session, navigate, full upload round trip ("File Uploaded!"
  + exact filename), audit log writing on the new relay code.

## v0.1.8 changes (2026-10-01 deep-verify hardening batch)
- Hardening batch from the first deep verification (see CHECKPOINT.md pass 2:
  P1-1, P1-2, P2-1..P2-5, P2-7..P2-9 verified real, correct, and tested):
  CONNECTING-window outbox (cap 50, FIFO flush), ghost pending-session
  rollback on tab-create/debugger-attach failures with persist, relay send
  guards with rollback on session_request/stop, and related audit coverage.
  (P2-6, the outbox flush order, was wrong in v0.1.8 and fixed in v0.1.9.)

## v0.1.7 changes (2026-10-01 deep verify, continued)
- Fixed: `upload_file`'s resolveNode->requestNode chain failed live with
  "Could not find node with given id" (requestNode's objectId lookup is
  unreliable). Now passes `backendNodeId` straight to `DOM.setFileInputFiles`,
  which accepts it natively. Battery updated (19/19).
- Fixed: relay crashed when the browser socket errored during disconnect (no
  ws 'error' listener; Node throws on unhandled 'error' events). Added socket
  and server error listeners. Also hardened `audit()` so a disk hiccup can
  never throw inside an event handler.

## v0.1.6 changes (2026-10-01 deep verify, continued)
- Fixed: `upload_file` used `DOM.resolveNode` and destructured `{ nodeId }`, but
  CDP's resolveNode returns `{ object }` (a JS wrapper), never a nodeId. (Superseded
  by the v0.1.7 direct-backendNodeId fix above.)

## v0.1.5 changes (2026-10-01 deep verify)
- Fixed: relay audit now records `via` (standing-grant vs tap) and `tabId` on session_consent.
- Fixed: `move_mouse` controller sent `coordinateX/Y`, extension expected `x/y` - now aligned, verified live.
- Added: `list_resources` and `download_resource` for Manus parity (page resources via content script, download via chrome.downloads).
- Added: explicit WebSocket `maxPayload` 10MB.
- New: sleeker geometric rabbit-head icon (amber gold on deep navy).

## Goal

Let your AI agent see and operate your real Chrome - your logins, your tabs,
your local network - for tasks you assign, with you watching and able to stop
it instantly.

## Topology

The relay runs on a machine you control (a VPS, a home server, or the same
machine that runs your agent). Your browser reaches it over a private channel -
in the reference deployment, an SSH remote forward so both ends are localhost
with no LAN or internet exposure.

```
Your machine (Chrome)                          Your server
┌─────────────────────┐   ws://127.0.0.1:18791     ┌────────────────┐
│ Companion extension  │◄──── (private channel, ──►│ relay server   │
│  - service worker    │   localhost only)         │  Node + ws     │◄── agent CLI
│  - content script    │   {type,id,...}           │  sessions,     │    (localhost
│  - action mask UI    │                           │  audit log     │     HTTP+token)
│  - popup (pair/auth) │                           └────────────────┘
└─────────────────────┘
```

- The extension only ever makes **outbound** connections (works behind NAT, no
  inbound firewall rules). Same trick Manus uses.
- The relay is a tiny Node service, bound to 127.0.0.1 by default. Reach it
  from the browser machine over SSH (`-R 127.0.0.1:18791:localhost:18791`),
  a VPN, or any other private channel. Localhost on both ends: no
  LAN/internet exposure at all.
- The agent drives it via a small Python CLI over localhost HTTP with a token.
  Nothing runs on the browser machine except the extension itself.

## Consent model

Pair once, and the agent can then drive any time without further taps. The
pairing grant is a standing, revocable setting:

1. The agent requests a session: `POST /api/sessions {browserId, reason}` →
   session `pending`.
2. With the standing grant (default ON; visible and revocable in the popup as
   "Ask me to allow each session"): the extension starts the session
   immediately, no card, no timeout. The audit log records `via:
   "standing-grant"` on the `session_consent` event.
3. With the grant revoked (per-session taps): the extension pops a consent
   card (auto-opened popup + notification fallback + badge): "Browser Companion wants to
   drive a browser tab - *<reason>*. [Allow once] [Deny]". 60s timeout →
   auto-deny.
4. On allow: the extension opens a **dedicated tab** at the bundled
   `src/session.html` start page (which runs the companion script natively;
   `about:blank` is unusable because the platform hard-blocks
   `scripting.executeScript` into top-level `about:blank` tabs, proven by
   probe 2026-10-01), in a tab group named "Companion", attaches the debugger,
   shows the action mask ("Companion is browsing…" + Take over / Stop).
   Session → `active`. The mask must draw or the session aborts (fail closed
   on visibility).
5. You can **Take over** (pauses agent input, you drive) or **Stop** (kills the
   session, detaches debugger, closes the dedicated tab) at any time. Closing the
   tab also ends the session. Fail-closed everywhere.

Tradeoff, stated plainly: with the standing grant, anything holding the agent
credential on the agent machine can drive the paired Chrome at any time without a tap.
The always-visible tab banner with Take over / Stop, plus closing the tab,
remains the kill switch.

## Observation: what the agent sees

After every action the extension returns **artifacts**:

```json
{
  "status": "success",
  "artifacts": {
    "url": "https://…", "title": "…",
    "viewport": {"w": 1440, "h": 900},
    "screenshot": "<base64 jpeg>",
    "elements": [
      {"i": 7, "role": "button", "name": "Add to cart",
       "x": 1210, "y": 342, "w": 120, "h": 40, "hash": "a3f9…"}
    ]
  }
}
```

- `elements` is a paint-order-sorted, visibility-filtered index of interactive
  elements built with CDP `DOMSnapshot.captureSnapshot` (JS DOM walk fallback).
- Every action targets an element by **index + hash**; the hash is verified
  against a fresh index at action time, and a mismatch aborts the action
  (no stale clicks). Same guard Manus uses. Hash comparison is prefix-tolerant
  (either side may be truncated); if the index shuffled but the hash is found
  elsewhere in the fresh index, the target is relocated instead of failing.

## Action vocabulary (fixed, small)

`view` (screenshot + fresh index), `navigate`, `click`, `input`, `scroll`,
`press_key`, `select_option`, `move_mouse`, `find_keyword`, `upload_file`,
`list_downloads`, `list_resources`, `download_resource` (`download_resources`
alias accepted). Duplicate action ids return cached results.

Anything outside this vocabulary is impossible by construction - the extension
has no generic "run JS" action. (The service worker can evaluate JS internally
for indexing, but the agent cannot send arbitrary scripts. This is deliberate.)

## Extension permissions (narrower than Manus)

`tabs, tabGroups, storage, debugger, scripting, alarms, notifications, downloads` + `<all_urls>` for the
content script. **No `cookies` permission** (Manus requests it; we don't need it -
the agent works *through* the logged-in session, never reading cookie jars).
Debugger attaches only to the session's dedicated tab, only while the session is
active and consented.

Known residual risk (shared with Manus's design): `<all_urls>` content-script +
`debugger` is powerful. Mitigations: consent-gated sessions, always-visible
action mask, fail-closed on tab close, per-action audit log on the relay,
no cookie permission, no arbitrary-JS action, short-lived session model.

## Protocol (extension ↔ relay, plain WebSocket + JSON)

Extension → relay: `hello {deviceToken, browserName, version, clientId, capabilities, activeSessions[]}`,
`pong`, `action_result {id, sessionId, status, result?, error?}`,
`event {kind: session_consent {state, tabId?, via?}|session_ended|takeover}`.
Relay → extension: `welcome {browserId, sessions[]}`, `ping`, `session_request {sessionId, reason}`,
`action {id, sessionId, action}`, `session_end {sessionId, reason}`.
The extension queues outbound messages while the socket is CONNECTING (cap 50)
and flushes FIFO only AFTER hello on open; the relay closes pre-auth messages.

Agent → relay (plain HTTP on localhost, `Authorization: Bearer <apiToken>`;
acceptable because the relay binds 127.0.0.1 only and the browser machine reaches it
over the mac-tunnel SSH forward):
`POST /pair` + `POST /revoke` (unauthenticated, pairing-code / device-token),
`GET /api/browsers`, `POST /api/sessions`, `GET /api/sessions/:id`,
`POST /api/sessions/:id/stop`, `POST /api/act {sessionId, action}` (synchronous,
per-session FIFO, ~45s timeout per dispatch; every response carries the
authoritative relay `id` + `sessionId`), `GET /api/audit`.

## Pairing (one time)

1. Operator runs `node server.js gencode` on the relay host → prints `DB-<32 hex>`
   (128-bit, single-use, 10 min TTL).
2. Open the extension popup → "Pair with your agent" → enters the code.
3. Extension exchanges code → receives `deviceToken`, stores in
   `chrome.storage.local`, opens the WebSocket. Done - it shows "Connected as
   <browserName>".

## Files

- `extension/` - the MV3 extension (load unpacked in `chrome://extensions`).
- `relay/` - `server.js`, runs on the relay host as a systemd unit
  (`companion-relay.service`), localhost-only, behind your private channel.
- `agent/browser_companion.py` - the agent CLI: browsers, request-session, act,
  snapshot, stop, audit.

## Out of scope for v1

Multi-tab sessions (one dedicated tab per session), file downloads to the Mac,
cross-browser (Chrome only), Firefox/Safari, the manus.im-style web bridge

