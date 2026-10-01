# Browser Companion

A clean-room Chrome extension + relay server that lets your AI agent see and
operate your real Chrome, with you watching and able to stop it instantly.

Your agent gets your logins, your tabs, your local network. You get an
always-visible banner in the driven tab with **Take over** and **Stop**, and
closing the tab ends the session instantly (fail-closed).

## How it works

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

Three parts:

- `extension/` — Chrome MV3 extension. Service worker (relay socket, sessions,
  CDP control, action dispatch), content script (action-mask overlay, in-page
  actions), popup (pairing, consent, settings).
- `relay/` — tiny Node server (`server.js`, needs the `ws` package).
  WebSocket for extensions, token-authenticated HTTPS API for the agent.
- `agent/browser_companion.py` — the agent-side CLI: list browsers,
  request sessions, run actions, stop, audit.

The extension only makes **outbound** connections (works behind NAT, no inbound
firewall rules). The relay binds `127.0.0.1` by default; reach it from the
browser machine over SSH (`-R 127.0.0.1:18791:localhost:18791`), a VPN, or any
other private channel.

## Setup

### 1. Relay

```bash
cd relay && npm install
node server.js gencode   # prints a one-time pairing code (10 min TTL)
node server.js showtoken  # the agent API token
```

Run it as a service (`companion-relay.service` is a systemd unit template).
Data (devices, pairing codes, audit log) lives in `relay/data/` — set
`DBC_DATA` to move it.

### 2. Extension

`chrome://extensions` → Developer mode → **Load unpacked** → select
`extension/`. Click the ⚡ toolbar icon, enter your relay URL and the pairing
code, done.

### 3. Agent CLI

```bash
# ~/.config/browser-companion/config.json  {"relay":"http://127.0.0.1:18791","token":"…"}  (chmod 600)
python3 agent/browser_companion.py browsers
python3 agent/browser_companion.py request-session --browser <id> --reason "…" --wait 90
python3 agent/browser_companion.py act --session <sid> --type view --shot-prefix shot
python3 agent/browser_companion.py act --session <sid> --type click --target-idx 7 --target-hash abc123
python3 agent/browser_companion.py stop --session <sid>
python3 agent/browser_companion.py audit --session <sid>
```

## Safety model

- **Consent per session**, in the browser, by you (notification + popup, 60s
  auto-deny; optional standing-grant toggle, default off).
- **Always-visible overlay** in the driven tab with **Take over** (pauses the
  agent) and **Stop**. Closing the tab ends the session instantly.
- **Fixed action vocabulary** — view, click, input, scroll, navigate,
  press_key, and friends. No arbitrary-JS action exists for the agent.
- **Stale-element guard**: every targeted action carries the element's index +
  hash; mismatches abort instead of clicking the wrong thing.
- **No `cookies` permission.** The extension drives your logged-in session;
  it never exfiltrates credentials.
- **Audit log** on the relay: every session event and every action with timing.

## Tests

```bash
cd test && npm install
npm test   # sw, content, session-page, and relay batteries
```

## Docs

- `DESIGN.md` — architecture, consent model, action vocabulary rationale.
- `MANUS-REVERSE-ENGINEERING.md` — behavioral notes from studying Manus's
  "My Browser" extension (behavior only; no Manus code or assets reused).

## License

MIT. See `LICENSE`.
