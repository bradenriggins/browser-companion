#!/usr/bin/env python3
"""Browser Companion agent CLI - agent CLI.

Lets your agent (this machine) drive a paired Chrome via the relay server.

Config: ~/.config/browser-companion/config.json  {"relay": "https://host:port", "token": "..."}

Commands:
  browsers                                  list connected browsers
  request-session --browser ID --reason "..." [--wait SEC]
  act --session ID --type click --target-idx 7 [--text ...] [--url ...] [--key ...]
      --type view|navigate|click|input|scroll|press_key|select_option|move_mouse|find_keyword|upload_file|list_downloads|list_resources|download_resource
      [--target-hash H] [--text T] [--url U] [--key K] [--direction D] [--to-end]
      [--x N --y N] [--value V] [--label L] [--keyword K] [--press-enter] [--double]
      [--resource-index N] [--resource-url U]
  raw --session ID --file action.json       send a hand-written action payload
  stop --session ID
  audit [--session ID]
  Screenshots are saved from any view-bearing result with --shot-prefix PREFIX.
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error, uuid

CFG_PATH = os.path.expanduser("~/.config/browser-companion/config.json")

def cfg():
    try:
        with open(CFG_PATH) as f: return json.load(f)
    except FileNotFoundError:
        sys.exit(f"no config at {CFG_PATH}; create it with relay URL + agent token")

def api(method, path, body=None, timeout=60):
    c = cfg()
    req = urllib.request.Request(c["relay"].rstrip("/") + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {c['token']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try: detail = json.load(e)
        except Exception: detail = e.read().decode()[:200]
        sys.exit(f"HTTP {e.code}: {detail}")

def cmd_browsers(_):
    d = api("GET", "/api/browsers")
    print(json.dumps(d, indent=2))

def cmd_request_session(a):
    d = api("POST", "/api/sessions", {"browserId": a.browser, "reason": a.reason})
    sid = d["sessionId"]
    print(f"session {sid}: {d['state']} - activating on standing grant (no tap needed)…", flush=True)
    if a.wait:
        deadline = time.time() + a.wait
        while time.time() < deadline:
            time.sleep(2)
            s = api("GET", f"/api/sessions/{sid}")
            if s["state"] == "active":
                print(f"session {sid} ACTIVE (tab {s.get('tabId')})")
                return
            if s["state"] in ("denied", "ended", "error"):
                sys.exit(f"session {sid}: {s['state']} ({s.get('reason','')})")
        sys.exit(f"timed out after {a.wait}s waiting for consent")
    print(f"poll: browser_companion.py session-status --session {sid}")

def cmd_session_status(a):
    print(json.dumps(api("GET", f"/api/sessions/{a.session}"), indent=2))

def build_action(a):
    act = {"type": a.type, "actionId": f"a-{uuid.uuid4().hex}"}
    if a.target_idx is not None:
        act["target"] = {"strategy": "byIndex", "index": a.target_idx}
        if a.target_hash: act["target"]["hash"] = a.target_hash
    if a.text is not None: act["text"] = a.text
    if a.url: act["url"] = a.url
    if a.key: act["key"] = a.key
    if a.direction: act["direction"] = a.direction
    if a.to_end: act["toEnd"] = True
    if a.x is not None: act["x"] = a.x
    if a.y is not None: act["y"] = a.y
    if a.value: act["value"] = a.value
    if a.label: act["label"] = a.label
    if a.keyword: act["keyword"] = a.keyword
    if a.press_enter: act["pressEnter"] = True
    if a.double: act["clickType"] = "double"
    if a.files: act["files"] = a.files
    if a.resource_index is not None: act["resourceIndex"] = a.resource_index
    if a.resource_url: act["resourceUrl"] = a.resource_url
    return act

def show_result(r, save_prefix=None):
    art = (r.get("result") or {}).get("artifacts") or r.get("artifacts")
    print(f"status: {r.get('status')}")
    if r.get("error"): print(f"error: {r['error']}")
    res = r.get("result") or {}
    if res.get("message"): print(f"message: {res['message']}")
    if art:
        print(f"url: {art.get('url')}\ntitle: {art.get('title')}")
        els = art.get("elements") or []
        print(f"elements: {len(els)}")
        for e in els[:60]:
            print(f"  [{e['i']}] {e['role']:12} {e.get('name','')[:50]!r:54} h={e.get('hash','')}")
        if len(els) > 60: print(f"  … +{len(els)-60} more")
        if save_prefix and art.get("screenshot"):
            import os as _os
            p = f"{save_prefix}.jpg"
            _parent = _os.path.dirname(_os.path.abspath(p))
            _os.makedirs(_parent, exist_ok=True)
            with open(p, "wb") as f: f.write(base64.b64decode(art["screenshot"]))
            print(f"screenshot: {p}")

def cmd_act(a):
    r = api("POST", "/api/act", {"sessionId": a.session, "action": build_action(a)}, timeout=90)
    show_result(r, save_prefix=a.shot_prefix)

def cmd_raw(a):
    with open(a.file) as f: action = json.load(f)
    r = api("POST", "/api/act", {"sessionId": a.session, "action": action}, timeout=90)
    show_result(r, save_prefix=a.shot_prefix)

def cmd_stop(a):
    print(json.dumps(api("POST", f"/api/sessions/{a.session}/stop", {}), indent=2))

def cmd_audit(a):
    q = f"?sessionId={a.session}" if a.session else ""
    d = api("GET", f"/api/audit{q}")
    for e in d["entries"]:
        print(json.dumps(e))

def main():
    p = argparse.ArgumentParser(description="Browser Companion agent CLI agent CLI")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("browsers")
    r = sub.add_parser("request-session"); r.add_argument("--browser", required=True); r.add_argument("--reason", required=True); r.add_argument("--wait", type=int, default=90)
    s = sub.add_parser("session-status"); s.add_argument("--session", required=True)
    for name, fn in [("act", cmd_act), ("raw", cmd_raw)]:
        q = sub.add_parser(name); q.add_argument("--session", required=True); q.add_argument("--shot-prefix", default=None)
        if name == "act":
            q.add_argument("--type", required=True, choices=["view","navigate","click","input","scroll","press_key","select_option","move_mouse","find_keyword","upload_file","list_downloads","list_resources","download_resource"])
            q.add_argument("--target-idx", type=int, default=None); q.add_argument("--target-hash", default=None)
            q.add_argument("--text", default=None); q.add_argument("--url", default=None); q.add_argument("--key", default=None)
            q.add_argument("--direction", default=None, choices=["up","down","left","right"]); q.add_argument("--to-end", action="store_true")
            q.add_argument("--x", type=int, default=None); q.add_argument("--y", type=int, default=None)
            q.add_argument("--value", default=None); q.add_argument("--label", default=None); q.add_argument("--keyword", default=None)
            q.add_argument("--press-enter", action="store_true"); q.add_argument("--double", action="store_true")
            q.add_argument("--files", nargs="*", default=None, help="absolute file paths on the Mac (upload_file only)")
            q.add_argument("--resource-index", type=int, default=None); q.add_argument("--resource-url", default=None)
        else:
            q.add_argument("--file", required=True)
    t = sub.add_parser("stop"); t.add_argument("--session", required=True)
    u = sub.add_parser("audit"); u.add_argument("--session", default=None)
    args = p.parse_args()
    {"browsers": cmd_browsers, "request-session": cmd_request_session, "session-status": cmd_session_status,
     "act": cmd_act, "raw": cmd_raw, "stop": cmd_stop, "audit": cmd_audit}[args.cmd](args)

if __name__ == "__main__":
    main()
