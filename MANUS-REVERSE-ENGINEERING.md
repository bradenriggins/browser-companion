# Manus "My Browser" Extension - Reverse Engineering Notes

Source: `cecngibhkljoiafhjfmcgbmikfogdiko` v0.0.62 (built 2026-08-28), pulled from
A MacBook Air, Chrome. Bundle is Vite-minified; findings below are
from manifest + string/behavior analysis of the minified JS, not decompiled source.

## What the product is (public)

"Manus AI Browser Operator": a Chrome/Edge MV3 extension that turns the user's own
logged-in local browser into an agent-operated browser. Flow: enable the "My Browser"
connector on manus.im → install extension → Manus requests one-time authorization per
task → agent drives a dedicated tab group → user watches live, can take over or close
the tab to stop. Launched Nov 2025, beta on Pro/Plus/Team. Sources: manus.im/blog/manus-browser-operator,
AlternativeTo, testingcatalog.

## Architecture (from the bundle)

```
manus.im web app <--postMessage--> extension <--Socket.IO--> wss://api.manus.im <-- Manus agent cloud
                                          |
                                     chrome.debugger (CDP) + content script
                                          |
                                     dedicated tab(s) in a named tab group
```

## Key mechanisms

1. **Transport**: Socket.IO client in the service worker, `wss://api.manus.im`,
   `auth: { token, branch? }`, `transports: ["websocket"]`. Token lives in
   `chrome.storage.local` (`manus_extension_token`). Every upstream message carries an
   envelope: `{id, timestamp, clientId, ua, version, browserName, allowOtherClient,
   skipAuthorization, capabilities}`. Events observed: `my_browser_extension_message`
   with `type` in {`browser_action`, `session_status`, `my_browser_extension_connected`};
   upstream `activate_extension`, `extension_take_over_summary`, `extension_stop_session`.

2. **Two control planes**:
   - `chrome.debugger` (CDP) attached to the session tab: `Runtime.evaluate`,
     `Input.dispatchMouseEvent/KeyEvent`, `Page.captureScreenshot`, `DOM.*`,
     `DOMSnapshot.captureSnapshot`, `Network.*`, `Emulation.*`.
   - Content script (`assets/BSzF9B3i.js`, injected at `document_start` on `<all_urls>`)
     for in-page work: element indexing, clicks/inputs/scrolls, find-keyword, uploads.

3. **Observation**: after every action (and on `browser_view`), `collectArtifacts`
   runs: waits for the content script, grabs viewport info, then
   `DOMSnapshot.captureSnapshot({computedStyles, includeDOMRects: true, includePaintOrder: true})`
   via CDP with a 5s timeout and a JS-scan fallback. Nodes are sorted by paint order,
   filtered to visible/clickable, indexed, and stamped onto the DOM via a
   `data-*` attribute (`[xe]` selector in the bundle). A screenshot rides along.

4. **Stale-element guard**: click/input/select/upload actions carry `target.index`;
   before acting, the SW runs `checkIndexedElementHash` - the indexed element's hash
   must still match, otherwise the action aborts instead of clicking the wrong thing.

5. **Action vocabulary** (server → extension): `browser_view`, `browser_navigate`,
   `browser_click`, `browser_input`, `browser_scroll`, `browser_press_key`,
   `browser_select_option`, `browser_move_mouse`, `browser_find_keyword`,
   `browser_list_resources`, `browser_download_resources`, `browser_upload_file`.
   Duplicate `actionId`s return cached results (idempotency).

6. **User-visibility layer**: an "ActionMask" overlay injected into the page -
   states `idle/hidden/ongoing/takeover`, banner text "Manus is browsing…", with
   Stop / Resume / Take-over controls. A separate tiny content script on
   `https://manus.im/*` runs the "Manus App Bridge": the web app `postMessage`s
   `{source: "manus-app", …}` and the extension replies `{source: "my-browser", …}`
   (origin-checked against `webAppDomain`).

7. **Session bookkeeping**: `mybrowser_active_sessions` (`{sessionId, tabId}`) in
   session storage; per-browser settings (`browserName` like "Swift-Fox",
   `allowCrossBrowser`, `skipAuthorization`, `disableTabGroup`) in local storage.
   Popup offers: Start new task, Visit Task, Revoke authorization.

8. **Permissions** (manifest): `alarms, tabs, tabGroups, storage, debugger, cookies,
   scripting` + `<all_urls>` host permissions. Note: this exact combo
   (`<all_urls>` + `cookies` + `debugger` + content scripts) is the one flagged by
   third-party audits as high-risk (credential-exfil / zero-click takeover class).
   Our build deliberately drops `cookies` and keeps everything else consent-gated.

## What to steal (design seeds)

- Socket-style persistent outbound connection from the extension (no inbound ports,
  works behind NAT) with a per-install `clientId` + token auth envelope.
- Indexed-DOM + screenshot artifacts after every action; hash-checked indexed
  targeting so the agent never clicks a stale element.
- Always-on in-page overlay with Take over / Stop; closing the tab kills the
  session (fail-closed); action log for auditability.
- Web-app ↔ extension bridge via `postMessage` with strict origin checks.
- Dedicated tab group per task so the user can watch without losing their own tabs.
