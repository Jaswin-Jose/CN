/* ui.js — Simulation Control Interface, dashboards, capture viewer and
   Packet Manager. Reads model state; changes it only through the other
   modules' functions. */
(function () {
  const U = (Sim.ui = {});
  const $ = (id) => document.getElementById(id);
  const esc = Sim.fmt.esc;
  const F = Sim.fmt;
  U.selectedPacketId = null;
  let view = "network";
  let addConn = "wifi";
  let eventFilter = "all";
  let drawerLinkId = null;
  let drawerFrame = null;   // selected frame object in the drawer
  let drawerCount = -1;
  let pmSel = null;         // selected packet id in Packet Manager
  let pmFrameIdx = 0;
  let pmSig = "";

  /* ---------- Toast ---------- */
  let toastTimer;
  U.toast = function (msg, bad) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (bad ? " bad" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), bad ? 4200 : 2400);
  };

  function segBind(el, onPick) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      el.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
      onPick(b.dataset.v);
    });
  }
  function segSet(el, v) { el.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x.dataset.v === v)); }

  /* ================= Top bar ================= */
  function bindTop() {
    $("btn-run").addEventListener("click", () => setRunning(!Sim.state.running));
    $("btn-step").addEventListener("click", () => { if (Sim.state.running) setRunning(false); Sim.engine.advance(100); });
    $("btn-reset").addEventListener("click", () => {
      Sim.engine.reset();
      closeDrawer();
      pmSel = null;
      U.toast("Run reset — same network, fresh counters, seed " + Sim.settings.seed);
    });
    const sp = $("sel-speed");
    [0.05, 0.1, 0.25, 0.5, 1, 2, 4].forEach((v) => sp.add(new Option(v + "×", v)));
    sp.value = Sim.settings.speed;
    sp.addEventListener("change", () => (Sim.settings.speed = +sp.value));
    segBind($("seg-profile"), (v) => {
      Sim.settings.profile = v;
      Sim.log.add("info", `Load profile set to ${Sim.PROFILES[v].label} (intervals ×${Sim.PROFILES[v].factor})`);
    });
    $("btn-layout").addEventListener("click", () => {
      Sim.scenarios.load("home");
      Sim.render.fit();
      closeDrawer();
      pmSel = null;
      U.toast("Smart Home network restored and run restarted");
    });
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  }
  function setRunning(on) {
    Sim.state.running = on;
    $("btn-run").textContent = on ? "Pause" : "Start";
    $("btn-run").classList.toggle("primary", !on);
  }
  U.setRunning = setRunning;

  function showView(v) {
    view = v;
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("is-active", t.dataset.view === v);
      t.setAttribute("aria-selected", t.dataset.view === v);
    });
    $("view-network").hidden = v !== "network";
    $("view-packets").hidden = v !== "packets";
    if (v === "packets") { pmSig = ""; renderPM(true); }
  }
  U.showView = showView;

  /* ================= Add device ================= */
  function bindAdd() {
    const sel = $("add-type");
    const g1 = document.createElement("optgroup");
    g1.label = "Sensors";
    Object.entries(Sim.topology.SENSORS).forEach(([k, c]) => g1.appendChild(new Option(`${c.label} sensor`, k)));
    const g2 = document.createElement("optgroup");
    g2.label = "Network";
    Object.entries(Sim.topology.INFRA).forEach(([k, c]) => g2.appendChild(new Option(c.label, k)));
    sel.append(g1, g2);
    const syncConn = () => {
      const isSensor = !!Sim.topology.SENSORS[sel.value];
      $("add-conn-row").hidden = !isSensor;
      const c = Sim.topology.SENSORS[sel.value] || Sim.topology.INFRA[sel.value];
      $("add-hint").textContent = isSensor
        ? `${c.chip}. Reports every ${(c.interval / 1000).toFixed(1)} s. ` + (addConn === "wifi" ? "Joins the strongest gateway in range." : "Cabled to the nearest gateway.")
        : sel.value === "gateway" ? "Wi-Fi access point + router + NAT. Cabled to the nearest router or server." : sel.value === "router" ? "Forwards traffic between gateways and servers. Cabled to the nearest server." : "Final endpoint. Stores readings and measures delay.";
    };
    sel.addEventListener("change", syncConn);
    segBind($("seg-conn"), (v) => { addConn = v; syncConn(); });
    syncConn();
    $("btn-add").addEventListener("click", () => addDevice(sel.value, addConn));
  }

  function freeSpot(cx, cy, rMin, rMax) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * (rMax - rMin);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (Sim.state.nodes.every((n) => Math.hypot(n.x - x, n.y - y) > 44)) return [x, y];
    }
    return [cx + rMin, cy];
  }

  function addDevice(kind, conn) {
    const T = Sim.topology, C = Sim.connections;
    const selNode = Sim.render.sel && Sim.render.sel.type === "node" ? Sim.nodeById(Sim.render.sel.id) : null;
    const center = Sim.render.center();
    let node;
    if (T.SENSORS[kind]) {
      const gw = selNode && selNode.role === "gateway" ? selNode : T.nearest(center.x, center.y, (n) => n.role === "gateway" && n.enabled) || T.nearest(center.x, center.y, (n) => n.role === "gateway");
      const pm = Sim.PX_PER_M;
      const [x, y] = gw ? freeSpot(gw.x, gw.y, (conn === "wifi" ? 8 : 9) * pm, (conn === "wifi" ? gw.range * 0.7 : 16) * pm) : freeSpot(center.x, center.y, 40, 160);
      node = T.addNode(kind, x, y, { conn });
      Sim.sensors.initState(node);
      if (conn === "ethernet") {
        if (gw) C.addWire(node, gw);
        else U.toast("No gateway yet — the sensor is waiting for a cable.", true);
      } else C.associate(node);
      Sim.engine.scheduleSensor(node);
      Sim.log.add("info", `${node.name} added (${T.SENSORS[kind].label}, ${conn === "wifi" ? "Wi-Fi" : "Ethernet"}, MAC ${node.mac})`);
    } else {
      const [x, y] = freeSpot(center.x, center.y, 60, 220);
      node = T.addNode(kind, x, y);
      if (kind === "gateway" || kind === "router") {
        const up = T.nearest(x, y, (n) => n !== node && (kind === "gateway" ? n.role === "router" : false)) || T.nearest(x, y, (n) => n.role === "server");
        if (up) C.addWire(node, up);
      }
      Sim.log.add("info", `${node.name} added (${T.INFRA[kind].label}, ${node.ip})`);
      C.refreshAll();
    }
    Sim.render.select({ type: "node", id: node.id });
    Sim.emit("topology");
    U.toast(`${node.name} added${node.ip ? " · " + node.ip : ""}`);
  }

  /* ================= Tool ================= */
  function bindTool() {
    segBind($("seg-tool"), (v) => {
      Sim.render.tool = v;
      $("canvas").classList.toggle("tool-wire", v === "wire");
      $("tool-hint").textContent = v === "wire"
        ? "Drag from one device to another to lay a cable. Sensors can only be cabled to a gateway."
        : "Drag devices to move them — Wi-Fi signal changes with distance. Click a link to see its packets. Click a moving packet to inspect it.";
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea")) return;
      if (e.key === "Escape") { closeDrawer(); Sim.render.select(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && Sim.render.sel) { e.preventDefault(); deleteSelection(); }
      if (e.key === " ") { e.preventDefault(); setRunning(!Sim.state.running); }
      if (e.key === "w") $("seg-tool").querySelector('[data-v="wire"]').click();
      if (e.key === "v") $("seg-tool").querySelector('[data-v="select"]').click();
    });
    $("z-in").addEventListener("click", () => Sim.render.zoomBy(1.2));
    $("z-out").addEventListener("click", () => Sim.render.zoomBy(1 / 1.2));
    $("z-fit").addEventListener("click", () => Sim.render.fit());
  }

  function deleteSelection() {
    const s = Sim.render.sel;
    if (!s) return;
    if (s.type === "node") {
      const n = Sim.nodeById(s.id);
      if (!n) return;
      Sim.topology.removeNode(n);
      Sim.log.add("info", `${n.name} removed from the network`);
      U.toast(`${n.name} removed`);
    } else {
      const l = Sim.linkById(s.id);
      if (!l) return;
      if (l.type === "wifi") { U.toast("Wi-Fi links follow signal strength. Move the sensor or change the gateway range instead.", true); return; }
      Sim.connections.removeLink(l);
      Sim.log.add("info", `Cable ${Sim.connections.label(l)} removed`);
      Sim.connections.refreshAll();
      if (drawerLinkId === l.id) closeDrawer();
      U.toast("Cable removed");
    }
    Sim.render.select(null);
    Sim.emit("topology");
  }

  /* ================= Inspector ================= */
  function kv(rows) {
    return `<dl class="kv">${rows.map(([k, v, live]) => `<dt>${k}</dt><dd${live ? ` data-live="${live}"` : ""}>${v}</dd>`).join("")}</dl>`;
  }
  function renderInspector() {
    const el = $("inspector");
    const s = Sim.render.sel;
    if (!s) {
      el.innerHTML = `<h2>Inspector</h2><p class="empty-insp">Select a device or a link on the canvas to see its addresses, signal, route and settings.</p>`;
      return;
    }
    if (s.type === "link") return renderLinkInspector(el, Sim.linkById(s.id));
    const n = Sim.nodeById(s.id);
    if (!n) { el.innerHTML = ""; return; }
    const T = Sim.topology;
    const cat = T.SENSORS[n.kind] || T.INFRA[n.role];
    const colorVar = n.role === "sensor" ? `var(--s-${n.kind})` : "var(--ink)";
    let html = `<h2>Inspector <button class="btn danger" id="i-del">Delete</button></h2>
      <div class="insp-title"><span class="dot" style="background:${colorVar}"></span><div><h3>${esc(n.name)}</h3><small>${esc(cat.label)}${n.role === "sensor" ? " sensor" : ""} · ${esc(cat.chip)}</small></div></div>`;
    if (n.role === "sensor") {
      html += kv([
        ["MAC", n.mac], ["IP (DHCP)", n.ip || "—", "ip"], ["Attached to", "—", "gw"],
        [n.conn === "wifi" ? "Signal" : "Link", "—", "sig"], ["Last reading", "—", "last"],
        ["Sent / recv / lost", "—", "cnt"],
      ]);
      html += `<div class="route" data-live="route"></div>`;
      html += `<div class="form-grid">
        <label class="span2">Name<input type="text" id="i-name" value="${esc(n.name)}" maxlength="16"></label>
        <label>Report every (ms)<input type="number" id="i-int" min="100" max="60000" step="100" value="${n.interval}"></label>
        <label>Connect by<select id="i-conn"><option value="wifi">Wi-Fi</option><option value="ethernet">Ethernet</option></select></label>
      </div>
      <label class="toggle"><input type="checkbox" id="i-en" ${n.enabled ? "checked" : ""}> Powered on</label>
      <label class="toggle"><input type="checkbox" id="i-faulty" ${n.faulty ? "checked" : ""}> Faulty (sends out-of-range spikes)</label>
      <button class="btn" id="i-pkts">Show this sensor's packets</button>`;
    } else if (n.role === "gateway") {
      html += kv([
        ["LAN IP", n.ip + "/24"], ["WAN IP", n.wanIp], ["BSSID (wlan0)", n.lanMac], ["WAN MAC (eth1)", n.wanMac],
        ["SSID", `${n.ssid} · ch ${n.channel}`], ["Clients", "—", "clients"], ["Queue", "—", "queue"],
        ["Forwarded / dropped", "—", "fwd"], ["NAT entries", "—", "nat"],
      ]);
      html += `<div class="route" data-live="route"></div>`;
      html += `<div class="form-grid">
        <label class="span2">Name<input type="text" id="i-name" value="${esc(n.name)}" maxlength="16"></label>
        <label class="span2">Wi-Fi range: <output id="i-range-o">${n.range} m</output><input type="range" id="i-range" min="5" max="60" value="${n.range}"></label>
        <label>Queue capacity<input type="number" id="i-qcap" min="1" max="500" value="${n.queueCap}"></label>
        <label>Processing (ms/pkt)<input type="number" id="i-proc" min="0.1" max="500" step="0.5" value="${n.procTime}"></label>
      </div>
      <label class="toggle"><input type="checkbox" id="i-wifi" ${n.wifi ? "checked" : ""}> Wi-Fi access point on</label>
      <label class="toggle"><input type="checkbox" id="i-en" ${n.enabled ? "checked" : ""}> Online (untick to simulate a gateway failure)</label>`;
    } else if (n.role === "router") {
      html += kv([["IP", n.ip], ["MAC", n.mac], ["Queue", "—", "queue"], ["Forwarded / dropped", "—", "fwd"]]);
      html += `<div class="route" data-live="route"></div>`;
      html += `<div class="form-grid">
        <label class="span2">Name<input type="text" id="i-name" value="${esc(n.name)}" maxlength="16"></label>
        <label>Queue capacity<input type="number" id="i-qcap" min="1" max="500" value="${n.queueCap}"></label>
        <label>Processing (ms/pkt)<input type="number" id="i-proc" min="0.1" max="500" step="0.5" value="${n.procTime}"></label>
      </div>
      <label class="toggle"><input type="checkbox" id="i-en" ${n.enabled ? "checked" : ""}> Online</label>`;
    } else {
      html += kv([["IP", n.ip], ["MAC", n.mac], ["Service", "CoAP · udp/5683"], ["Packets received", "—", "recv"], ["Sensors reporting", "—", "srcs"]]);
      html += `<div class="form-grid"><label class="span2">Name<input type="text" id="i-name" value="${esc(n.name)}" maxlength="16"></label></div>
      <label class="toggle"><input type="checkbox" id="i-en" ${n.enabled ? "checked" : ""}> Online</label>`;
    }
    el.innerHTML = html;
    liveInspector();

    $("i-del").addEventListener("click", deleteSelection);
    const nm = $("i-name");
    nm.addEventListener("change", () => {
      const v = nm.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 16);
      if (!v) return (nm.value = n.name);
      if (Sim.state.nodes.some((o) => o !== n && o.name === v)) { U.toast(`${v} is already used`, true); nm.value = n.name; return; }
      n.name = v; nm.value = v;
      renderInspector();
    });
    const en = $("i-en");
    en.addEventListener("change", () => {
      if (n.role === "sensor") { n.enabled = en.checked; Sim.log.add("info", `${n.name} powered ${en.checked ? "on" : "off"}`); }
      else Sim.engine.setEnabled(n, en.checked);
    });
    if (n.role === "sensor") {
      $("i-conn").value = n.conn;
      $("i-conn").addEventListener("change", (e) => {
        const err = Sim.connections.setConn(n, e.target.value);
        if (err) { U.toast(err, true); e.target.value = n.conn; }
        Sim.emit("topology");
        renderInspector();
      });
      $("i-int").addEventListener("change", (e) => { n.interval = Sim.clamp(+e.target.value || n.interval, 100, 60000); e.target.value = n.interval; });
      $("i-faulty").addEventListener("change", (e) => { n.faulty = e.target.checked; Sim.log.add("fault", `${n.name} ${n.faulty ? "now sends faulty readings" : "readings back to normal"}`); });
      $("i-pkts").addEventListener("click", () => { showView("packets"); $("pm-sensor").value = n.id; renderPM(true); });
    }
    if (n.role === "gateway") {
      const r = $("i-range");
      r.addEventListener("input", () => { n.range = +r.value; $("i-range-o").textContent = n.range + " m"; Sim.connections.refreshAll(); Sim.touch(); });
      $("i-wifi").addEventListener("change", (e) => { n.wifi = e.target.checked; Sim.log.add("fault", `${n.name} Wi-Fi ${n.wifi ? "enabled" : "disabled"}`); Sim.connections.refreshAll(); Sim.touch(); });
    }
    if ($("i-qcap")) {
      $("i-qcap").addEventListener("change", (e) => { n.queueCap = Sim.clamp(Math.round(+e.target.value) || n.queueCap, 1, 500); e.target.value = n.queueCap; });
      $("i-proc").addEventListener("change", (e) => { n.procTime = Sim.clamp(+e.target.value || n.procTime, 0.1, 500); e.target.value = n.procTime; });
    }
  }

  function renderLinkInspector(el, l) {
    if (!l) { el.innerHTML = ""; return; }
    const wifi = l.type === "wifi";
    const bws = wifi ? [1, 6, 12, 24, 54, 150] : [10, 100, 1000];
    el.innerHTML = `<h2>Inspector ${wifi ? "" : '<button class="btn danger" id="i-del">Delete cable</button>'}</h2>
      <div class="insp-title"><span class="dot" style="background:${wifi ? "var(--wifi)" : "var(--cable)"}"></span><div><h3>${esc(Sim.connections.label(l))}</h3><small>${wifi ? "IEEE 802.11 Wi-Fi association (2.4 GHz)" : Sim.connections.isUplink(l) ? "Ethernet uplink (backhaul)" : "Ethernet cable"}</small></div></div>
      ${kv([["Frames", "—", "lf"], ["Lost / retries", "—", "ll"], ["Avg hop latency", "—", "lat"], wifi ? ["Signal", "—", "lsig"] : ["Medium", l.bandwidth >= 1000 ? "1000BASE-T" : l.bandwidth + "BASE-TX"]])}
      <div class="form-grid">
        <label>${wifi ? "PHY rate" : "Bandwidth"} (Mbit/s)<select id="i-bw">${bws.map((b) => `<option ${b === l.bandwidth ? "selected" : ""}>${b}</option>`).join("")}</select></label>
        <label>Latency (ms)<input type="number" id="i-lat" min="0" max="2000" placeholder="default" value="${l.latency ?? ""}"></label>
        <label class="span2">Extra loss on this link: <output id="i-loss-o">${l.loss}%</output><input type="range" id="i-loss" min="0" max="80" value="${l.loss}"></label>
      </div>
      <button class="btn primary" id="i-cap">Open packet capture</button>`;
    liveInspector();
    if (!wifi) $("i-del").addEventListener("click", deleteSelection);
    $("i-bw").addEventListener("change", (e) => (l.bandwidth = +e.target.value));
    $("i-lat").addEventListener("change", (e) => (l.latency = e.target.value === "" ? null : Sim.clamp(+e.target.value, 0, 2000)));
    $("i-loss").addEventListener("input", (e) => { l.loss = +e.target.value; $("i-loss-o").textContent = l.loss + "%"; });
    $("i-cap").addEventListener("click", () => U.openLink(l.id));
  }

  function liveInspector() {
    const s = Sim.render.sel;
    if (!s) return;
    const set = (k, v) => { const e = document.querySelector(`#inspector [data-live="${k}"]`); if (e && e.innerHTML !== v) e.innerHTML = v; };
    if (s.type === "link") {
      const l = Sim.linkById(s.id);
      if (!l) return;
      set("lf", `${l.stats.frames} · ${(l.stats.bytes / 1024).toFixed(1)} KiB`);
      set("ll", `${l.stats.lost} / ${l.stats.retries}`);
      set("lat", l.stats.ok ? F.ms(l.stats.latSum / l.stats.ok) : "—");
      if (l.type === "wifi") {
        const a = Sim.nodeById(l.a), b = Sim.nodeById(l.b);
        if (a && b) { const r = Sim.connections.rssi(a, b); set("lsig", `${r.toFixed(0)} dBm · ${Sim.connections.quality(r)} · FER ${(Sim.connections.per(r) * 100).toFixed(1)}%`); }
      }
      return;
    }
    const n = Sim.nodeById(s.id);
    if (!n) return;
    const st = n.stats;
    const routeHtml = () => {
      const r = Sim.routing.describe(n);
      return r ? `Route: ${r.map((x) => `<b>${esc(x)}</b>`).join(" → ")}` : `<span style="color:var(--bad)">No route to a server</span>`;
    };
    if (n.role === "sensor") {
      const gw = n.gwId ? Sim.nodeById(n.gwId) : null;
      set("ip", n.ip || "—");
      set("gw", gw ? esc(gw.name) : "—");
      if (n.conn === "wifi") {
        const l = n.wifiLinkId && Sim.linkById(n.wifiLinkId);
        const g = l && Sim.nodeById(l.b);
        if (g) { const r = Sim.connections.rssi(n, g); set("sig", `${r.toFixed(0)} dBm · ${Sim.connections.quality(r)} · ${Sim.connections.distanceM(n, g).toFixed(1)} m`); }
        else set("sig", "Out of range");
      } else set("sig", Sim.connections.wireOf(n) ? "100BASE-TX" : "No cable");
      set("last", n.lastReading ? esc(Sim.sensors.format(n.kind, n.lastReading.v)) : "—");
      set("cnt", `${st.sent} / ${st.delivered} / ${st.lost}`);
      set("route", routeHtml());
    } else if (n.role === "gateway") {
      const clients = Sim.state.nodes.filter((x) => x.role === "sensor" && x.gwId === n.id).length;
      set("clients", `${clients}`);
      set("queue", `${n.queue.length}/${n.queueCap} (peak ${st.peakQueue})`);
      set("fwd", `${st.forwarded} / ${st.dropped}`);
      set("nat", `${Object.keys(n.nat).length}`);
      set("route", routeHtml());
    } else if (n.role === "router") {
      set("queue", `${n.queue.length}/${n.queueCap} (peak ${st.peakQueue})`);
      set("fwd", `${st.forwarded} / ${st.dropped}`);
      set("route", routeHtml());
    } else {
      set("recv", `${st.received}`);
      set("srcs", `${Object.keys(n.store).length}`);
    }
  }

  /* ================= Network conditions ================= */
  const SLIDERS = [
    ["extraLoss", "Link drop probability", 0, 50, 1, (v) => v + "%"],
    ["wifiLatency", "Wi-Fi hop latency", 1, 300, 1, (v) => v + " ms"],
    ["wiredLatency", "Sensor cable latency", 1, 100, 1, (v) => v + " ms"],
    ["uplinkLatency", "Uplink / WAN latency", 1, 400, 1, (v) => v + " ms"],
    ["jitter", "Jitter (random variation)", 0, 100, 1, (v) => "±" + v + "%"],
    ["noise", "Wi-Fi interference", 0, 20, 1, (v) => v + " dB"],
    ["retryLimit", "802.11 retry limit", 0, 7, 1, (v) => v + (v === 1 ? " retry" : " retries")],
    ["delayThreshold", "Late if delay exceeds", 50, 2000, 10, (v) => v + " ms"],
  ];
  function bindSettings() {
    const box = $("settings");
    box.innerHTML = SLIDERS.map(([k, label, min, max, step]) => `<div class="slider"><label for="s-${k}">${label}</label><output id="o-${k}"></output><input type="range" id="s-${k}" min="${min}" max="${max}" step="${step}"></div>`).join("") +
      `<div class="row between"><label class="lbl" for="s-seed">Random seed</label><input type="number" id="s-seed" style="width:96px"></div>
       <p class="hint">Same seed + same settings gives the same result after Reset.</p>`;
    SLIDERS.forEach(([k, , , , , fmt]) => {
      const inp = $("s-" + k);
      inp.addEventListener("input", () => { Sim.settings[k] = +inp.value; $("o-" + k).textContent = fmt(+inp.value); });
      inp.addEventListener("change", () => Sim.log.add("info", `Setting changed: ${k} = ${inp.value}`));
    });
    $("s-seed").addEventListener("change", (e) => { Sim.settings.seed = Math.max(1, Math.round(+e.target.value) || 1); e.target.value = Sim.settings.seed; U.toast("Seed set. Press Reset to rerun with it."); });
    $("f-surge").addEventListener("click", () => { Sim.scenarios.trafficSurge(10); U.toast("Traffic surge for 10 s"); });
    $("f-noise").addEventListener("click", () => { Sim.scenarios.interference(10); U.toast("Interference burst: −10 dB for 10 s"); });
    $("f-gw").addEventListener("click", () => { const g = Sim.scenarios.failRandomGateway(15); U.toast(g ? `${g.name} offline for 15 s` : "No online gateway to fail", !g); });
    $("f-snap").addEventListener("click", saveSnapshot);
  }
  function syncSettings() {
    SLIDERS.forEach(([k, , , , , fmt]) => { $("s-" + k).value = Sim.settings[k]; $("o-" + k).textContent = fmt(Sim.settings[k]); });
    $("s-seed").value = Sim.settings.seed;
    segSet($("seg-profile"), Sim.settings.profile);
    $("sel-speed").value = Sim.settings.speed;
  }
  U.syncSettings = syncSettings;

  function saveSnapshot() {
    const s = Sim.metrics.snapshot();
    U.toast(`Snapshot #${s.n} saved — compare runs in Packet Manager`);
    if (view === "packets") renderPM(true);
  }

  /* ================= Right panel ================= */
  const CTRS = [
    ["generated", "Generated", "var(--ink-3)"],
    ["forwarded", "Forwarded", "var(--queued)"],
    ["delivered", "Received", "var(--ok)"],
    ["delayed", "Delayed", "var(--warn)"],
    ["lost", "Lost", "var(--bad)"],
    ["inFlight", "In flight", "var(--travel)"],
  ];
  function renderStats() {
    const m = Sim.metrics.compute();
    $("counters").innerHTML = CTRS.map(([k, l, c]) => `<div class="ctr"><span><i style="background:${c}"></i>${l}</span><b>${m[k]}</b></div>`).join("");
    const done = m.delivered + m.lost;
    $("summary").innerHTML = `
      <dt>Delivery success</dt><dd>${F.pct(m.deliveryPct)}</dd>
      <dt>Packet loss</dt><dd>${F.pct(m.lossPct)}</dd>
      <dd class="formula">${m.lost} lost ÷ ${done} finished × 100</dd>
      <dt>Avg end-to-end delay</dt><dd>${F.ms(m.avgDelay)}</dd>
      <dt>Jitter (delay std dev)</dt><dd>${F.ms(m.jitter)}</dd>
      <dt>Throughput</dt><dd>${m.throughput.toFixed(2)} pkt/s</dd>
      <dt>Traffic intensity</dt><dd>${m.intensity.toFixed(1)} pkt/s</dd>
      <dt>Queue now / peak</dt><dd>${m.queueNow} / ${m.peakQueue}</dd>
      <dt>802.11 retransmissions</dt><dd>${m.retries}</dd>`;
    spark($("spark-del"), Sim.metrics.series("del"), "--ok", $("sv-del"), (v) => v + " pkt/s");
    spark($("spark-delay"), Sim.metrics.series("delay"), "--accent", $("sv-delay"), (v) => (v == null ? "—" : v.toFixed(0) + " ms"));
    // server inbox
    const rows = [];
    Sim.state.nodes.filter((n) => n.role === "server").forEach((srv) => Object.values(srv.store).forEach((r) => rows.push(r)));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    $("inbox").innerHTML = rows.length
      ? rows.map((r) => `<li><i style="background:var(--s-${r.kind})"></i><span>${esc(r.name)}</span><b>${esc(Sim.sensors.format(r.kind, r.value))}</b><small>${((Sim.state.now - r.t) / 1000).toFixed(1)} s ago · ${r.delay.toFixed(0)} ms trip</small></li>`).join("")
      : `<li class="empty">Waiting for the first reading…</li>`;
    renderEvents();
    $("tab-count").textContent = Sim.state.pktSeq;
  }

  const sparkHover = new WeakMap();
  function spark(cv, data, colorVar, label, fmt) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const color = cs.getPropertyValue(colorVar).trim();
    const W = r.width, H = r.height, pad = 4;
    const vals = data.map((v) => (v == null ? 0 : v));
    const max = Math.max(1, ...vals) * 1.1;
    const n = Math.max(2, data.length);
    const X = (i) => pad + (i / (n - 1)) * (W - pad * 2);
    const Y = (v) => H - pad - (v / max) * (H - pad * 2);
    c.strokeStyle = cs.getPropertyValue("--line").trim();
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, H - pad + 0.5); c.lineTo(W, H - pad + 0.5); c.stroke();
    const hv = sparkHover.get(cv);
    if (!data.length) { label.textContent = "—"; return; }
    c.beginPath();
    vals.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
    c.lineTo(X(vals.length - 1), H - pad); c.lineTo(X(0), H - pad); c.closePath();
    c.globalAlpha = 0.15; c.fillStyle = color; c.fill(); c.globalAlpha = 1;
    c.beginPath();
    vals.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))));
    c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
    const idx = hv != null ? Math.min(vals.length - 1, Math.round((hv / W) * (n - 1))) : vals.length - 1;
    c.beginPath(); c.arc(X(idx), Y(vals[idx]), 3, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    if (hv != null) {
      c.strokeStyle = cs.getPropertyValue("--ink-3").trim(); c.beginPath(); c.moveTo(X(idx), 0); c.lineTo(X(idx), H); c.stroke();
      label.textContent = `${fmt(data[idx])} at ${idx - (vals.length - 1)} s`;
    } else label.textContent = fmt(data[idx]);
  }
  function bindSparks() {
    ["spark-del", "spark-delay"].forEach((id) => {
      const cv = $(id);
      cv.addEventListener("pointermove", (e) => sparkHover.set(cv, e.clientX - cv.getBoundingClientRect().left));
      cv.addEventListener("pointerleave", () => sparkHover.delete(cv));
    });
  }

  const EVF = { all: null, drop: ["drop"], deliver: ["deliver", "delay"], queue: ["queue", "forward"], wifi: ["assoc", "dhcp"], fault: ["fault", "info"] };
  function bindEvents() {
    $("ev-chips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      eventFilter = b.dataset.f;
      $("ev-chips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-on", c === b));
      renderEvents();
    });
    $("events").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-p]");
      if (li) { pmSel = +li.dataset.p; pmFrameIdx = 0; showView("packets"); }
    });
  }
  let lastEvSig = "";
  function renderEvents() {
    const f = EVF[eventFilter];
    const items = [];
    const all = Sim.log.items;
    for (let i = all.length - 1; i >= 0 && items.length < 80; i--) if (!f || f.includes(all[i].type)) items.push(all[i]);
    const sig = eventFilter + ":" + Sim.log.total;
    if (sig === lastEvSig) return;
    lastEvSig = sig;
    $("events").innerHTML = items.map((e) => `<li class="${e.type}"${e.pktId ? ` data-p="${e.pktId}" style="cursor:pointer"` : ""}><time>${F.clock(e.t).slice(0, 8)}</time><span>${esc(e.text)}</span></li>`).join("");
  }

  /* ================= Dissection (tree + hex) ================= */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function arrival(tSim) {
    const ms = Sim.EPOCH_MS + tSim;
    const d = new Date(Math.floor(ms));
    const frac = String(Math.round((ms % 1000) * 1e6)).padStart(9, "0");
    const p = (x) => String(x).padStart(2, "0");
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${frac} UTC`;
  }
  U.dissect = function (fr, treeEl, hexEl) {
    const link = Sim.linkById(fr.linkId);
    let html = `<details open><summary>Frame ${fr.no}: ${fr.len} bytes on wire (${fr.len * 8} bits), ${fr.len} bytes captured</summary>
      <div class="f meta">Arrival Time: ${arrival(fr.time)}</div>
      <div class="f meta">Time since start of run: ${(fr.time / 1000).toFixed(6)} s</div>
      <div class="f meta">Captured on: ${esc(link ? Sim.connections.label(link) : fr.srcName + " → " + fr.dstName)} (${fr.medium === "wifi" ? "802.11 radio" : "Ethernet"})</div>
      <div class="f meta">Direction: ${esc(fr.srcName)} → ${esc(fr.dstName)} · attempt ${fr.attempt}${fr.retry ? " (802.11 retransmission)" : ""}</div>
      <div class="f ${fr.lost ? "badv" : "goodv"}">Outcome: ${fr.lost ? "Discarded by receiver — FCS check failed (bit errors / radio noise)" : "Received by " + esc(fr.dstName)}</div>
      <div class="f meta">[Protocols in frame: ${fr.protos}]</div></details>`;
    fr.layers.forEach((L) => {
      html += `<details open><summary data-o="${L.start}" data-l="${L.end - L.start}">${esc(L.title)}</summary>` +
        L.fields.map((f) => `<div class="f${f.bad ? " badv" : f.good ? " goodv" : ""}" data-o="${f.off}" data-l="${f.len}">${esc(f.label)}</div>`).join("") + `</details>`;
    });
    treeEl.innerHTML = `<div class="tree">${html}</div>`;
    const b = fr.bytes;
    let hx = "";
    for (let r = 0; r < b.length; r += 16) {
      let h = "", a = "";
      for (let i = r; i < r + 16; i++) {
        if (i < b.length) {
          h += `<span data-i="${i}">${F.hex2(b[i])}</span>`;
          const ch = b[i] >= 32 && b[i] < 127 ? String.fromCharCode(b[i]) : ".";
          a += `<span data-i="${i}">${esc(ch)}</span>`;
        } else h += "<span>  </span>";
        if (i === r + 7) h += " ";
      }
      hx += `<div class="r"><span class="o">${r.toString(16).padStart(4, "0")}</span><span class="h">${h}</span><span class="a">${a}</span></div>`;
    }
    hexEl.innerHTML = `<div class="hex">${hx}</div>`;
    const spans = hexEl.querySelectorAll("span[data-i]");
    const mark = (o, l, cls) => {
      spans.forEach((s) => { const i = +s.dataset.i; s.classList.toggle(cls, i >= o && i < o + l); });
    };
    treeEl.onmouseover = (e) => { const t = e.target.closest("[data-o]"); if (t) mark(+t.dataset.o, +t.dataset.l, "hi"); };
    treeEl.onmouseleave = () => mark(0, 0, "hi");
    treeEl.onclick = (e) => {
      const t = e.target.closest("[data-o]");
      if (!t) return;
      treeEl.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel"));
      t.classList.add("sel");
      mark(+t.dataset.o, +t.dataset.l, "sel");
    };
    hexEl.onclick = (e) => {
      const s = e.target.closest("span[data-i]");
      if (!s) return;
      const i = +s.dataset.i;
      let best = null;
      treeEl.querySelectorAll(".f[data-o]").forEach((f) => {
        const o = +f.dataset.o, l = +f.dataset.l;
        if (i >= o && i < o + l && (!best || l < +best.dataset.l)) best = f;
      });
      if (best) {
        treeEl.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel"));
        best.classList.add("sel");
        best.closest("details").open = true;
        best.scrollIntoView({ block: "nearest" });
        mark(+best.dataset.o, +best.dataset.l, "sel");
      }
    };
  };

  /* ================= Link capture drawer ================= */
  const visibleFrames = (l) => l.captures.filter((f) => f.time <= Sim.state.now);
  U.openLink = function (linkId, frame) {
    const l = Sim.linkById(linkId);
    if (!l) return;
    if (view !== "network") showView("network");
    drawerLinkId = linkId;
    drawerFrame = frame || null;
    drawerCount = -1;
    $("drawer").hidden = false;
    renderDrawer(true);
  };
  U.openPacketOnLink = function (pktId, linkId) {
    const l = Sim.linkById(linkId);
    if (!l) return;
    const fr = visibleFrames(l).filter((f) => f.pktId === pktId).pop() || null;
    U.selectedPacketId = pktId;
    Sim.render.select({ type: "link", id: linkId });
    U.openLink(linkId, fr);
    $("dr-follow").checked = false;
  };
  function closeDrawer() {
    $("drawer").hidden = true;
    drawerLinkId = null;
    drawerFrame = null;
    U.selectedPacketId = null;
  }
  function renderDrawer(force) {
    const l = drawerLinkId && Sim.linkById(drawerLinkId);
    if (!l) { if (drawerLinkId) closeDrawer(); return; }
    const frames = visibleFrames(l);
    const a = Sim.nodeById(l.a), b = Sim.nodeById(l.b);
    const wifi = l.type === "wifi";
    $("dr-kind").textContent = wifi ? "Wi-Fi capture · IEEE 802.11 · linktype 105" : "Ethernet capture · linktype 1";
    $("dr-title").textContent = Sim.connections.label(l);
    const r = wifi && a && b ? Sim.connections.rssi(a, b) : null;
    $("dr-meta").innerHTML = [
      `${frames.length} frames`, `${l.stats.lost} lost`, `${l.stats.retries} retries`,
      wifi ? `RSSI ${r.toFixed(0)} dBm (${Sim.connections.quality(r)})` : `${l.bandwidth >= 1000 ? "1 Gbit/s" : l.bandwidth + " Mbit/s"}`,
      l.stats.ok ? `avg hop ${F.ms(l.stats.latSum / l.stats.ok)}` : "",
    ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
    if (!force && frames.length === drawerCount) return;
    drawerCount = frames.length;
    const follow = $("dr-follow").checked;
    const show = frames.slice(-300);
    const list = $("dr-list");
    list.innerHTML = `<table class="cap"><thead><tr><th class="num">No.</th><th class="num">Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th class="num">Length</th><th>Info</th></tr></thead><tbody>${
      show.map((f) => `<tr data-n="${f.no}" class="${f.lost ? "lost" : f.retry ? "retry" : ""}${drawerFrame === f ? " sel" : ""}"><td class="num">${f.no}</td><td class="num">${(f.time / 1000).toFixed(6)}</td><td>${f.src}</td><td>${f.dst}</td><td>CoAP</td><td class="num">${f.len}</td><td class="info">${f.retry ? "[Retransmission] " : ""}${esc(f.info)}${f.lost ? " [FCS error]" : ""}</td></tr>`).join("")
    }</tbody></table>${frames.length ? "" : `<p class="pane-empty">No frames have crossed this link yet. ${Sim.state.running ? "Wait a moment." : "Press Start."}</p>`}`;
    list.querySelector("tbody").onclick = (e) => {
      const tr = e.target.closest("tr[data-n]");
      if (!tr) return;
      drawerFrame = l.captures.find((f) => f.no === +tr.dataset.n) || null;
      U.selectedPacketId = drawerFrame ? drawerFrame.pktId : null;
      $("dr-follow").checked = false;
      list.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
      tr.classList.add("sel");
      showDrawerFrame();
    };
    if (follow) {
      list.scrollTop = list.scrollHeight;
      if (!drawerFrame && frames.length) { drawerFrame = frames[frames.length - 1]; }
    }
    if (force || !drawerFrame || follow) showDrawerFrame();
    if (!follow && drawerFrame) {
      const row = list.querySelector(`tr[data-n="${drawerFrame.no}"]`);
      if (row && force) row.scrollIntoView({ block: "center" });
    }
  }
  function showDrawerFrame() {
    if (!drawerFrame) {
      $("dr-tree").innerHTML = `<p class="pane-empty">Select a frame to see every header field, decoded layer by layer.</p>`;
      $("dr-hex").innerHTML = `<p class="pane-empty">Raw bytes appear here. Hover a field to highlight its bytes.</p>`;
      return;
    }
    U.dissect(drawerFrame, $("dr-tree"), $("dr-hex"));
  }
  function bindDrawer() {
    $("dr-close").addEventListener("click", closeDrawer);
    $("dr-follow").addEventListener("change", () => { if ($("dr-follow").checked) { drawerFrame = null; renderDrawer(true); } });
    $("dr-pcap").addEventListener("click", () => {
      const l = Sim.linkById(drawerLinkId);
      if (!l) return;
      const frames = visibleFrames(l);
      if (!frames.length) return U.toast("No frames captured yet", true);
      const name = Sim.connections.label(l).replace(/\s*↔\s*/, "_").replace(/[^A-Za-z0-9_-]/g, "");
      Sim.log.download(`${name}.pcap`, new Blob([Sim.protocol.pcap(frames, l.type === "wifi" ? 105 : 1)], { type: "application/vnd.tcpdump.pcap" }))
        .then((ok) => ok && U.toast(`Saved ${name}.pcap (${frames.length} frames) — opens in Wireshark`));
    });
  }

  /* ================= Packet Manager ================= */
  function bindPM() {
    ["pm-q", "pm-status", "pm-sensor"].forEach((id) => $(id).addEventListener("input", () => renderPM(true)));
    $("pm-table").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-p]");
      if (!tr) return;
      pmSel = +tr.dataset.p;
      pmFrameIdx = 0;
      renderPM(true);
    });
    $("pm-snap").addEventListener("click", saveSnapshot);
    $("pm-csv").addEventListener("click", () => { Sim.log.download("iot-packets.csv", Sim.log.packetsCsv(), "text/csv").then((ok) => ok && U.toast("Saved iot-packets.csv")); });
    $("pm-log").addEventListener("click", () => { Sim.log.download("iot-event-log.txt", Sim.log.asText()).then((ok) => ok && U.toast("Saved iot-event-log.txt")); });
    $("pm-json").addEventListener("click", () => {
      const report = { generated: new Date().toISOString(), scenario: Sim.state.scenarioLabel, settings: Sim.settings, results: Sim.metrics.compute(), lossReasons: Sim.metrics.reasons, snapshots: Sim.metrics.snapshots, devices: deviceRows() };
      Sim.log.download("iot-experiment-report.json", JSON.stringify(report, null, 2), "application/json").then((ok) => ok && U.toast("Saved iot-experiment-report.json"));
    });
    $("pm-snap-clear").addEventListener("click", () => { Sim.metrics.snapshots = []; renderPM(true); });
  }

  function deviceRows() {
    return Sim.state.nodes.filter((n) => n.role === "sensor").map((n) => {
      const s = n.stats, done = s.delivered + s.lost;
      let sig = n.conn === "ethernet" ? "Ethernet" : "—";
      if (n.conn === "wifi" && n.wifiLinkId) { const l = Sim.linkById(n.wifiLinkId); const g = l && Sim.nodeById(l.b); if (g) sig = Sim.connections.rssi(n, g).toFixed(0) + " dBm"; }
      return { id: n.id, name: n.name, type: Sim.topology.SENSORS[n.kind].label, ip: n.ip || "—", mac: n.mac, link: sig, sent: s.sent, delivered: s.delivered, delayed: s.delayed, lost: s.lost, lossPct: done ? (s.lost / done) * 100 : null, avgDelay: s.delivered ? s.delaySum / s.delivered : null };
    });
  }

  function renderPM(force) {
    if (view !== "packets") return;
    const m = Sim.metrics.compute();
    const sig = [Sim.state.pktSeq, m.delivered, m.lost, pmSel, pmFrameIdx, Sim.metrics.snapshots.length].join(":");
    const K = (label, val, sub, lead) => `<div class="kpi${lead ? " lead" : ""}"><span>${label}</span><b>${val}</b><small>${sub}</small></div>`;
    $("pm-kpis").innerHTML = [
      K("Packets sent", m.generated, `${m.inFlight} still in flight`, true),
      K("Received", m.delivered, `${m.delayed} of them late`),
      K("Lost", m.lost, "dropped anywhere on the path"),
      K("Packet loss", F.pct(m.lossPct), "lost ÷ (received + lost)"),
      K("Delivery rate", F.pct(m.deliveryPct), "received ÷ (received + lost)"),
      K("Average delay", F.ms(m.avgDelay), "end to end, received only"),
      K("Jitter", F.ms(m.jitter), "std dev of delay"),
      K("Throughput", m.throughput.toFixed(2), `pkt/s · ${m.goodputKbps.toFixed(2)} kbit/s payload`),
      K("802.11 retries", m.retries, `of ${m.frames} frames sent`),
      K("Peak queue", m.peakQueue, `${m.queueNow} waiting now`),
    ].join("");
    $("pm-time").textContent = `${(m.secs).toFixed(1)} s simulated · ${Sim.state.scenarioLabel || "custom network"} · ${Sim.PROFILES[Sim.settings.profile].label} load`;
    if (!force && sig === pmSig) return;
    pmSig = sig;

    // sensor filter options
    const ss = $("pm-sensor");
    const cur = ss.value;
    const sensors = Sim.state.nodes.filter((n) => n.role === "sensor");
    const opts = `<option value="">All sensors</option>` + sensors.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("");
    if (ss.dataset.sig !== opts) { ss.innerHTML = opts; ss.dataset.sig = opts; ss.value = cur; }

    const q = $("pm-q").value.trim().toLowerCase();
    const stf = $("pm-status").value;
    const sf = ss.value;
    const rows = [];
    const P = Sim.state.packets;
    for (let i = P.length - 1; i >= 0 && rows.length < 400; i--) {
      const p = P[i];
      if (stf && p.status !== stf) continue;
      if (sf && p.sensorId !== sf) continue;
      if (q && !(`#${p.id} ${p.sensorName} ${p.origSrc} ${p.ip.dst} ${p.dropReason || ""}`.toLowerCase().includes(q))) continue;
      rows.push(p);
    }
    $("pm-rows").textContent = `${rows.length === 400 ? "Newest 400" : rows.length} of ${P.length} packets`;
    $("pm-table").querySelector("tbody").innerHTML = rows.map((p) => `<tr class="click${p.id === pmSel ? " sel" : ""}" data-p="${p.id}">
      <td class="mono num">${p.id}</td><td class="mono num">${(p.created / 1000).toFixed(3)}</td>
      <td><span class="row" style="gap:6px"><i style="width:8px;height:8px;border-radius:50%;background:var(--s-${p.kind});display:inline-block"></i>${esc(p.sensorName)}</span></td>
      <td class="mono">${p.origSrc} → ${p.ip.dst}</td><td class="mono">${esc(Sim.sensors.format(p.kind, p.value))}</td>
      <td class="mono num">${p.firstLen || "—"}</td><td class="mono num">${p.hops.length}</td><td class="mono num">${p.retries}</td>
      <td class="mono num">${p.delay != null ? p.delay.toFixed(1) : "—"}</td><td><span class="pill ${p.status}">${p.status}</span></td></tr>`).join("") ||
      `<tr><td colspan="10" class="note">No packets match these filters.</td></tr>`;

    renderPMDetail(force);

    // devices
    $("pm-devices").querySelector("tbody").innerHTML = deviceRows().map((d) => `<tr>
      <td>${esc(d.name)}</td><td>${esc(d.type)}</td><td class="mono">${d.ip}</td><td class="mono">${d.mac}</td><td class="mono">${d.link}</td>
      <td class="mono num">${d.sent}</td><td class="mono num">${d.delivered}</td><td class="mono num">${d.lost}</td>
      <td class="mono num">${F.pct(d.lossPct)}</td><td class="mono num">${F.ms(d.avgDelay)}</td>
      <td><span class="bar"><i style="width:${d.lossPct == null ? 0 : 100 - d.lossPct}%"></i></span></td></tr>`).join("");
    // links
    $("pm-links").querySelector("tbody").innerHTML = Sim.state.links.filter((l) => l.stats.frames).map((l) => `<tr class="click" data-l="${l.id}">
      <td>${esc(Sim.connections.label(l))}</td><td>${l.type === "wifi" ? "Wi-Fi" : Sim.connections.isUplink(l) ? "Uplink" : "Ethernet"}</td>
      <td class="mono num">${l.bandwidth}</td><td class="mono num">${l.stats.frames}</td><td class="mono num">${(l.stats.bytes / 1024).toFixed(1)}</td>
      <td class="mono num">${l.stats.retries}</td><td class="mono num">${l.stats.lost}</td><td class="mono num">${l.stats.ok ? F.ms(l.stats.latSum / l.stats.ok) : "—"}</td></tr>`).join("") ||
      `<tr><td colspan="8" class="note">No traffic yet.</td></tr>`;
    // loss reasons
    const LBL = { radio: "Wi-Fi radio loss (weak signal / interference)", link: "Cable bit errors", queue: "Gateway queue overflow", offline: "Gateway or node offline", noroute: "No route / not connected", validation: "Rejected by gateway validation", ttl: "TTL expired" };
    const reasons = Object.entries(Sim.metrics.reasons).sort((a, b) => b[1] - a[1]);
    $("pm-reasons").innerHTML = reasons.length ? reasons.map(([k, v]) => `<tr><td>${LBL[k] || k}</td><td class="mono num">${v}</td><td class="mono num">${F.pct((v / m.lost) * 100)}</td></tr>`).join("") : `<tr><td colspan="3" class="note">No packets lost yet.</td></tr>`;
    // snapshots
    const sn = Sim.metrics.snapshots;
    $("pm-snaps").querySelector("tbody").innerHTML = sn.length ? sn.map((s) => `<tr>
      <td class="mono num">${s.n}</td><td>${esc(s.scenario)}</td><td>${s.profile}</td><td class="mono num">${s.devices}</td><td class="mono">${s.gatewaysUp}</td>
      <td class="mono num">${s.extraLoss}%</td><td class="mono num">${s.noise} dB</td><td class="mono">${s.latency}</td><td class="mono num">${s.seed}</td>
      <td class="mono num">${s.secs.toFixed(1)}</td><td class="mono num">${s.generated}</td><td class="mono num">${s.delivered}</td><td class="mono num">${s.lost}</td>
      <td class="mono num">${F.pct(s.lossPct)}</td><td class="mono num">${F.ms(s.avgDelay)}</td><td class="mono num">${s.throughput.toFixed(2)}</td><td class="mono num">${s.peakQueue}</td></tr>`).join("")
      : `<tr><td colspan="17" class="note">Run an experiment, then press “Save snapshot” to record its conditions and results here. Change one setting, Reset, run again and save another to compare.</td></tr>`;
  }

  let pmDetailSig = "";
  function renderPMDetail(force) {
    const el = $("pm-detail");
    const p = pmSel != null && Sim.state.packets.find((x) => x.id === pmSel);
    const dsig = p ? [p.id, p.status, p.journey.length, p.hops.reduce((s, h) => s + h.frames.filter((f) => f.time <= Sim.state.now).length, 0), pmFrameIdx].join(":") : "none";
    if (!force && dsig === pmDetailSig) return;
    pmDetailSig = dsig;
    if (!p) {
      el.innerHTML = `<div class="card-head"><h2>Packet trace</h2></div><p class="note">Select a packet in the table to follow it hop by hop and see its bytes on every link.</p>`;
      return;
    }
    const frames = [];
    p.hops.forEach((h, hi) => h.frames.forEach((f) => { if (f.time <= Sim.state.now) frames.push({ f, hi, h }); }));
    if (pmFrameIdx >= frames.length) pmFrameIdx = Math.max(0, frames.length - 1);
    const start = p.created;
    el.innerHTML = `<div class="card-head"><h2>Packet #${p.id} · ${esc(p.sensorName)}</h2><span class="pill ${p.status}">${p.status}</span></div>
      <div class="body">
        ${kv([
          ["Reading", esc(Sim.sensors.format(p.kind, p.value))],
          ["Created", `${(p.created / 1000).toFixed(3)} s`],
          ["End-to-end delay", p.delay != null ? F.ms(p.delay) : p.status === "dropped" ? "— (lost)" : "in transit"],
          ["Source → destination", `${p.origSrc}:${p.origSport} → ${p.ip.dst}:5683`],
          ["NAT", p.nat ? `${p.nat.inside} → ${p.nat.outside} (${esc(p.nat.gw)})` : "—"],
          ["Hops / 802.11 retries", `${p.hops.length} / ${p.retries}`],
        ])}
        ${p.dropReason ? `<p class="pill dropped" style="white-space:normal;border-radius:6px;padding:4px 8px">${esc(p.dropReason)}</p>` : ""}
        <ol class="journey">${p.journey.map((j) => `<li><span class="nd ${j.type === "drop" ? "bad" : j.type === "deliver" || j.type === "delay" ? "ok" : j.type === "queue" ? "q" : ""}"></span><span>${esc(j.text)}</span><span class="t">+${(j.t - start).toFixed(1)} ms</span></li>`).join("")}</ol>
        <div class="stack"><span class="lbl">Frames on the wire — the same packet looks different on each link (MACs, TTL, NAT, checksums):</span>
          <div class="hopsel">${frames.map((x, i) => `<button class="btn${i === pmFrameIdx ? " primary" : ""}" data-fi="${i}">Hop ${x.hi + 1}${x.h.frames.length > 1 ? "." + x.f.attempt : ""} · ${x.h.medium === "wifi" ? "Wi-Fi" : "Eth"}${x.f.lost ? " ✕" : ""}</button>`).join("") || '<span class="hint">No frames yet.</span>'}</div>
        </div>
        ${frames.length ? `<div class="detail-pane" id="pm-tree"></div><div class="detail-pane" id="pm-hex"></div><button class="btn" id="pm-onlink">Show this frame in the link capture</button>` : ""}
      </div>`;
    el.querySelectorAll("[data-fi]").forEach((b) => b.addEventListener("click", () => { pmFrameIdx = +b.dataset.fi; renderPMDetail(true); }));
    if (frames.length) {
      const cur = frames[pmFrameIdx];
      U.dissect(cur.f, $("pm-tree"), $("pm-hex"));
      $("pm-onlink").addEventListener("click", () => { U.selectedPacketId = p.id; Sim.render.select({ type: "link", id: cur.f.linkId }); U.openLink(cur.f.linkId, cur.f); $("dr-follow").checked = false; renderDrawer(true); });
    }
  }

  /* ================= Boot + tick ================= */
  U.init = function () {
    bindTop(); bindAdd(); bindTool(); bindSettings(); bindEvents(); bindDrawer(); bindPM(); bindSparks();
    $("pm-links").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-l]"); if (tr) { Sim.render.select({ type: "link", id: tr.dataset.l }); U.openLink(tr.dataset.l); } });
    Sim.on("select", () => { renderInspector(); });
    Sim.on("topology", () => renderInspector());
    Sim.on("reset", () => { renderInspector(); lastEvSig = ""; drawerCount = -1; pmSig = ""; });
    Sim.on("scenario", () => syncSettings());
    renderInspector();
    syncSettings();
  };
  let tFast = 0, tSlow = 0;
  U.tick = function (ts) {
    $("clock").textContent = F.clock(Sim.state.now);
    if (ts - tFast > 250) {
      tFast = ts;
      renderStats();
      liveInspector();
      if (drawerLinkId) renderDrawer(false);
    }
    if (ts - tSlow > 700) {
      tSlow = ts;
      renderPM(false);
    }
  };
})();
