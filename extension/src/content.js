/* Browser Companion - content script (isolated world)
 * Owns: action-mask overlay (Take over / Stop), fallback DOM indexer,
 * in-page action helpers (input, scroll, select, find). Runs at document_start.
 */
(() => {
  "use strict";
  if (window.__companion) return;
  window.__companion = true;

  const IDX_ATTR = "data-companion-el";
  const registry = new Map(); // index -> element

  // ---------- action mask overlay ----------
  let maskHost = null, maskState = "idle", paused = false;

  function ensureMask() {
    if (maskHost) return maskHost;
    maskHost = document.createElement("div");
    maskHost.id = "companion-action-mask";
    maskHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .pill { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 10px;
        background: #111827; color: #f9fafb; border: 1px solid #f59e0b;
        border-radius: 9999px; padding: 8px 8px 8px 14px;
        font: 13px/1.4 -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,.45); white-space: nowrap; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #f59e0b;
        animation: pulse 1.2s infinite; }
      @keyframes pulse { 50% { opacity: .35; } }
      button { border: 1px solid #4b5563; background: #1f2937; color: #f9fafb;
        border-radius: 9999px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
      button:hover { background: #374151; }
      button.stop { border-color: #ef4444; color: #fca5a5; }
      .hidden { display: none; }`;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.innerHTML = `
      <span class="dot"></span><span class="label">Companion is browsing&hellip;</span>
      <button class="takeover">Take over</button>
      <button class="stop">Stop</button>`;
    pill.querySelector(".takeover").addEventListener("click", () => {
      paused = !paused;
      pill.querySelector(".label").textContent = paused ? "You have control - agent paused" : "Companion is browsing…";
      pill.querySelector(".takeover").textContent = paused ? "Resume agent" : "Take over";
      chrome.runtime.sendMessage({ type: "takeover", paused });
    });
    pill.querySelector(".stop").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "stopFromPage" });
    });
    maskHost.shadowRoot.append(style, pill);
    return maskHost;
  }

  function setMask(state) {
    maskState = state;
    const host = ensureMask();
    if (state === "idle" || state === "hidden") host.remove();
    else {
      if (!host.isConnected) document.documentElement.appendChild(host);
      // keep the label truthful across re-asserts (e.g. after navigation):
      // "takeover" means the session is paused with the user in control
      const label = host.shadowRoot.querySelector(".label");
      const btn = host.shadowRoot.querySelector(".takeover");
      if (label && btn) {
        if (state === "takeover" || paused) {
          label.textContent = "You have control - agent paused";
          btn.textContent = "Resume agent";
        } else {
          label.textContent = "Companion is browsing…";
          btn.textContent = "Take over";
        }
      }
    }
  }

  // ---------- fallback DOM indexer (used if CDP DOMSnapshot unavailable) ----------
  function contentHash(e) {
    // content-bound hash (mirrors the SW's hashStr intent): binds the index entry
    // to stable element identity so a stale hash still means something here
    const sig = `${e.tag}|${e.role}|${e.name}|${e.x},${e.y},${e.w},${e.h}`;
    let h = 5381;
    for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0;
    return "fb" + h.toString(16);
  }

  function fallbackIndex() {
    const els = [];
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > innerHeight + 200) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      // associated <label> text beats the input's own value (a checkbox's value is just "on")
      const labelText = (el.labels && el.labels[0] ? el.labels[0].innerText : "") || "";
      const name = (el.getAttribute("aria-label") || labelText || el.placeholder || el.title || el.alt || el.innerText || el.value || "").trim().slice(0, 80);
      // document-relative coords (client rect + scroll), matching the SW snapshot path
      els.push({ tag: el.tagName.toLowerCase(), role, name, x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
      if (els.length >= 400) break;
    }
    els.forEach((e, i) => { e.i = i; e.hash = contentHash(e); });
    return els;
  }

  function applyIndex(elements) {
    registry.clear();
    for (const meta of elements) {
      // resolve lazily on use: store meta only; lookup by coordinates/text is unreliable,
      // so for the fallback path we re-scan. For CDP path, SW clicks by coordinates.
      registry.set(meta.i, meta);
    }
  }

  function resolveElement(index) {
    // meta x/y are document-relative CSS px (both index paths); convert to client
    // coords with the live scroll offset before matching or hit-testing
    const meta = registry.get(index);
    if (!meta) return null;
    const cx = meta.x - window.scrollX, cy = meta.y - window.scrollY;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.x - cx) < 4 && Math.abs(r.y - cy) < 4) return el;
    }
    // fallback: elementFromPoint at center
    return document.elementFromPoint(cx + meta.w / 2, cy + meta.h / 2);
  }

  // ---------- in-page actions ----------
  function doInput(index, text, pressEnter) {
    const el = resolveElement(index);
    if (!el) return { ok: false, error: "element not found in page" };
    el.focus();
    el.scrollIntoView({ block: "center", behavior: "instant" });
    // checkboxes/radios: typing makes no sense; toggle instead
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      el.click();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    if (el.isContentEditable) {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } else {
      el.value = "";
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      // native setter so framework listeners fire
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Synthetic dispatched key events run JS listeners but never trigger
    // native default actions, so on a plain HTML form (no JS key handler)
    // Enter would silently do nothing. Dispatch the full sequence, then
    // fall back to requestSubmit so native forms submit too.
    if (pressEnter) {
      const seq = ["keydown", "keypress", "keyup"];
      for (const t of seq) el.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        try { form.requestSubmit(); } catch {}
      }
    }
    return { ok: true };
  }

  function doScroll({ direction, toEnd, index, x, y }) {
    let target = document.scrollingElement;
    if (index !== undefined) target = resolveElement(index) || target;
    const amt = Math.round(innerHeight * 0.8);
    const opts = { behavior: "instant" };
    if (toEnd) {
      if (direction === "up" || direction === "left") target.scrollTo({ ...opts, top: 0, left: 0 });
      else target.scrollTo({ ...opts, top: target.scrollHeight, left: target.scrollWidth });
    } else if (x !== undefined && y !== undefined) {
      target.scrollTo({ ...opts, left: x, top: y });
    } else {
      const d = { down: [0, amt], up: [0, -amt], left: [-amt, 0], right: [amt, 0] }[direction] || [0, amt];
      target.scrollBy({ ...opts, left: d[0], top: d[1] });
    }
    return { ok: true };
  }

  function doSelect(index, value, label) {
    const el = resolveElement(index);
    if (!el || el.tagName !== "SELECT") return { ok: false, error: "not a select element" };
    let matched = false;
    for (const opt of el.options) {
      const byValue = value !== undefined && opt.value === value;
      const byLabel = label !== undefined && (opt.label === label || opt.text === label);
      if (byValue || byLabel) {
        el.value = opt.value; matched = true; break;
      }
    }
    if (!matched) return { ok: false, error: "option not found" };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function doFind(keyword) {
    document.querySelectorAll("[data-companion-find]").forEach((e) => {
      e.replaceWith(document.createTextNode(e.textContent));
    });
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && (parent.tagName === "SCRIPT" || parent.tagName === "STYLE")) continue;
      if (walker.currentNode.nodeValue.toLowerCase().includes(keyword.toLowerCase())) nodes.push(walker.currentNode);
    }
    for (const node of nodes.slice(0, 50)) {
      const mark = document.createElement("mark");
      mark.setAttribute("data-companion-find", "1");
      mark.style.background = "#fbbf24";
      mark.textContent = node.nodeValue;
      node.replaceWith(mark);
      count++;
    }
    if (count) document.querySelector("[data-companion-find]")?.scrollIntoView({ block: "center" });
    return { ok: true, count };
  }

  function doListResources() {
    const urls = new Map();
    const push = (url, kind) => {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      try { url = new URL(url, location.href).href; } catch { return; }
      if (!urls.has(url)) urls.set(url, { url, kind, count: 1 });
      else urls.get(url).count++;
    };
    try {
      for (const e of performance.getEntriesByType("resource")) push(e.name, e.initiatorType || "resource");
    } catch {}
    document.querySelectorAll("img[src]").forEach((e) => push(e.src, "img"));
    document.querySelectorAll("script[src]").forEach((e) => push(e.src, "script"));
    document.querySelectorAll("link[rel=stylesheet][href]").forEach((e) => push(e.href, "stylesheet"));
    document.querySelectorAll("video[src], video source[src]").forEach((e) => push(e.src, "video"));
    document.querySelectorAll("audio[src], audio source[src]").forEach((e) => push(e.src, "audio"));
    document.querySelectorAll("a[href]").forEach((e) => {
      const href = e.href;
      if (/\.(pdf|zip|csv|xlsx?|docx?|pptx?|mp4|mp3|png|jpe?g|gif|webp|svg)$/i.test(href)) push(href, "link");
    });
    return { ok: true, resources: [...urls.values()].slice(0, 200) };
  }

  // ---------- message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case "ping": return { ok: true };
        case "mask": setMask(msg.state); return { ok: true };
        case "index": return { ok: true, elements: fallbackIndex() };
        case "setIndex": applyIndex(msg.elements); return { ok: true };
        case "doInput": return doInput(msg.index, msg.text, msg.pressEnter);
        case "doScroll": return doScroll(msg);
        case "doSelect": return doSelect(msg.index, msg.value, msg.label);
        case "doFind": return doFind(msg.keyword);
        case "doListResources": return doListResources();
        default: return { ok: false, error: "unknown" };
      }
    })().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });
})();
