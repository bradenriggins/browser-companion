/* Browser Companion - popup logic */
const $ = (id) => document.getElementById(id);

function send(type, extra = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...extra }, resolve));
}

async function refresh() {
  const st = await send("getState");
  const dot = $("dot"), txt = $("statusText");
  if (!st.paired) {
    $("pairView").style.display = "block";
    $("mainView").style.display = "none";
    dot.className = "dot off";
    txt.textContent = "Not paired";
    $("relayUrl").value = st.relayUrl || "";
    return;
  }
  $("pairView").style.display = "none";
  $("mainView").style.display = "block";
  dot.className = "dot " + (st.connected ? "on" : "off");
  txt.textContent = st.connected ? `Connected as ${st.browserName}` : "Paired - connecting…";
  $("relayUrl2").value = st.relayUrl || "";
  if (document.activeElement !== $("askEach")) $("askEach").checked = !st.alwaysAllow;

  const box = $("sessions");
  box.innerHTML = "";
  for (const s of st.sessions || []) {
    const div = document.createElement("div");
    div.className = "session";
    const age = Math.round((Date.now() - s.createdAt) / 1000);
    if (s.state === "pending") {
      div.innerHTML = `<div class="reason">Agent requests control</div>
        <div class="meta">${escapeHtml(s.reason || "")} · asked ${age}s ago</div>
        <div class="btnrow">
          <button data-a="allow">Allow once</button>
          <button data-a="deny" class="danger">Deny</button>
        </div>`;
      div.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", async () => {
          await send("consent", { sessionId: s.id, decision: b.dataset.a });
          refresh();
        }));
    } else {
      div.innerHTML = `<div class="reason">Session active</div>
        <div class="meta">${escapeHtml(s.reason || "")} · tab ${s.tabId} · ${s.paused ? "PAUSED - you have control" : "Agent driving"}</div>
        <button class="danger" data-a="stop">Stop session</button>`;
      div.querySelector("button").addEventListener("click", async () => {
        await send("stopSession", { sessionId: s.id });
        refresh();
      });
    }
    box.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("pairBtn").addEventListener("click", async () => {
  $("pairErr").textContent = "";
  $("pairBtn").disabled = true;
  try {
    const url = $("relayUrl").value.trim();
    if (url) await send("setRelayUrl", { url });
    const r = await send("pair", { code: $("pairCode").value.trim() });
    if (!r.ok) throw new Error(r.error || "pairing failed");
    refresh();
  } catch (e) { $("pairErr").textContent = e.message; }
  finally { $("pairBtn").disabled = false; }
});

$("saveBtn").addEventListener("click", async () => {
  const url = $("relayUrl2").value.trim();
  if (url) await send("setRelayUrl", { url });
  refresh();
});

$("askEach").addEventListener("change", async () => {
  await send("setAlwaysAllow", { value: !$("askEach").checked });
  refresh();
});

$("unpairBtn").addEventListener("click", async () => {
  if (confirm("Unpair this browser from your agent?")) { await send("unpair"); refresh(); }
});

refresh();
setInterval(refresh, 3000);
