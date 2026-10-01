// Runs INSIDE the test page. Stub chrome, inject the real content.js, exercise it.
(async () => {
  const results = [];
  const t = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

  // 1. stub chrome before injecting
  window.__csListener = null;
  window.chrome = { runtime: { onMessage: { addListener(fn) { window.__csListener = fn; } } } };
  const src = await (await fetch("/content.js")).text();
  (0, eval)(src);
  t("content.js injected, listener captured", typeof window.__csListener === "function");

  const send = (msg) => new Promise((resolve) => {
    window.__csListener(msg, {}, (resp) => resolve(resp));
  });

  // 2. index
  const idx = await send({ type: "index" });
  const els = idx.elements || [];
  t("index returns elements", idx.ok && els.length > 5, "count=" + els.length);
  t("elements have hashes", els.every((e) => typeof e.hash === "string" && e.hash.length > 0));
  const byId = {};
  for (const e of els) { /* map via resolve below */ }
  await send({ type: "setIndex", elements: els });

  // helper: find element index by matching page element via coordinates is overkill;
  // instead use registry order: find our targets by name/role in the index
  const findIdx = (pred) => { const e = els.find(pred); return e ? e.i : -1; };
  const nameIdx = findIdx((e) => e.role === "textbox" || (e.tag === "input" && /name/i.test(e.name)));
  // more robust: locate by DOM order - input#name is first input
  const inputs = els.filter((e) => e.tag === "input");
  t("fallback index found inputs", inputs.length >= 3, "inputs=" + inputs.length);

  // 3. doInput on text field: use coordinate resolve - pick the element whose name includes placeholder
  const nameEl = els.find((e) => /your name/i.test(e.name));
  t("name input indexed", !!nameEl, JSON.stringify(nameEl || {}).slice(0, 120));
  if (nameEl) {
    const r = await send({ type: "doInput", index: nameEl.i, text: "Test User" });
    t("doInput text ok", r.ok, JSON.stringify(r));
    t("input value set", document.getElementById("name").value === "Test User",
      "value=" + JSON.stringify(document.getElementById("name").value));
  }

  // 4. checkbox toggle
  const agreeEl = els.find((e) => /agree/i.test(e.name));
  if (agreeEl) {
    const before = document.getElementById("agree").checked;
    const r = await send({ type: "doInput", index: agreeEl.i, text: "ignored" });
    const after = document.getElementById("agree").checked;
    t("checkbox toggles via doInput", r.ok && before === false && after === true, `before=${before} after=${after}`);
  } else t("checkbox indexed", false, "not found");

  // 5. select by value, then by label
  const selEl = els.find((e) => e.tag === "select");
  if (selEl) {
    let r = await send({ type: "doSelect", index: selEl.i, value: "g" });
    t("doSelect by value", r.ok && document.getElementById("color").value === "g", JSON.stringify(r));
    r = await send({ type: "doSelect", index: selEl.i, label: "Blue" });
    t("doSelect by label", r.ok && document.getElementById("color").value === "b", JSON.stringify(r));
    r = await send({ type: "doSelect", index: selEl.i, value: "zzz" });
    t("doSelect bad option fails", !r.ok, JSON.stringify(r));
  } else t("select indexed", false, "not found");

  // 6. contenteditable: match by coordinates (name may be empty)
  const edRect = document.getElementById("editor").getBoundingClientRect();
  const edEl = els.find((e) => e.tag === "div" && Math.abs(e.x - (edRect.x + window.scrollX)) < 4);
  if (edEl) {
    const r = await send({ type: "doInput", index: edEl.i, text: "hello editor" });
    t("contenteditable input", r.ok && document.getElementById("editor").textContent.includes("hello editor"),
      JSON.stringify(document.getElementById("editor").textContent).slice(0, 60));
  } else t("contenteditable indexed", false, JSON.stringify(els.filter(e=>e.tag==="div").map(e=>e.name)));

  // 7. doFind: "zebra" appears in <script> (must skip), <p>, and <a> (must hit)
  const f = await send({ type: "doFind", keyword: "zebra" });
  t("doFind skips script/style", f.ok && f.count === 2, "count=" + f.count);

  // 8. doScroll to end, then resolve an off-viewport element (scroll-correctness)
  const s0 = window.scrollY;
  const sr = await send({ type: "doScroll", direction: "down", toEnd: true });
  const s1 = window.scrollY;
  const maxY = document.scrollingElement.scrollHeight - window.innerHeight;
  t("doScroll toEnd reaches page bottom", sr.ok && Math.abs(s1 - maxY) < 4, `y ${s0} -> ${s1} (max ${maxY})`);
  // deep link is near bottom; name input is at top (now off-viewport). doInput on it must still resolve.
  if (nameEl) {
    const r = await send({ type: "doInput", index: nameEl.i, text: "AfterScroll" });
    t("resolveElement works while scrolled", r.ok && document.getElementById("name").value === "AfterScroll",
      JSON.stringify(r) + " value=" + JSON.stringify(document.getElementById("name").value));
  }

  // 9. mask overlay shows
  const m = await send({ type: "mask", state: "active" });
  const pill = document.getElementById("companion-action-mask");
  t("mask overlay activates", m.ok && !!pill, "host=" + !!pill);
  // overlay controls must not leak into the index
  const idx2 = await send({ type: "index" });
  const leak = (idx2.elements || []).some((e) => /take over|stop/i.test(e.name || ""));
  t("overlay excluded from index", !leak);
  // 9b. setMask("takeover") re-assert keeps the paused label truthful
  // (regression: re-assert after navigation redrew the default label)
  const m2 = await send({ type: "mask", state: "takeover" });
  const labelEl = pill.shadowRoot.querySelector(".label");
  t("takeover mask shows paused label",
    m2.ok && labelEl && /you have control/i.test(labelEl.textContent),
    "label=" + JSON.stringify(labelEl && labelEl.textContent));

  // 10. pressEnter dispatches the full key sequence (keydown/keypress/keyup)
  // (regression: single keydown never triggered native form submission)
  if (nameEl) {
    const seen = [];
    const nameInput = document.getElementById("name");
    for (const ev of ["keydown", "keypress", "keyup"])
      nameInput.addEventListener(ev, (e) => seen.push(ev + ":" + e.key));
    const r = await send({ type: "doInput", index: nameEl.i, text: "EnterTest", pressEnter: true });
    t("doInput pressEnter ok", r.ok, JSON.stringify(r));
    t("pressEnter dispatches keydown/keypress/keyup",
      seen.join(",") === "keydown:Enter,keypress:Enter,keyup:Enter",
      seen.join(","));
  }

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, results };
})();
