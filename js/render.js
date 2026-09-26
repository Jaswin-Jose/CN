/* render.js — Visual Layer + Packet Movement Visualization
   Draws the topology, Wi-Fi coverage, links and moving packets on a canvas,
   and handles pointer interaction (select, drag, cable tool, pan, zoom). */
(function () {
  const V = (Sim.render = {});
  let canvas, ctx, dpr = 1, W = 0, H = 0;
  const view = (V.view = { x: 0, y: 0, z: 1 }); // screen = world * z + (x, y)
  let col = {};
  V.tool = "select";
  V.sel = null;          // { type: "node"|"link", id }
  V.hover = null;
  let wireFrom = null;   // node id while drawing a cable
  let pointer = { x: 0, y: 0, wx: 0, wy: 0 };
  let drag = null;

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    const g = (k) => cs.getPropertyValue(k).trim();
    col = {};
    ["--stage", "--grid", "--grid-major", "--ink", "--ink-2", "--ink-3", "--line", "--line-strong", "--surface", "--surface-2", "--accent", "--wifi", "--wifi-soft", "--cable", "--ok", "--warn", "--bad", "--queued"].forEach((k) => (col[k] = g(k)));
    Object.keys(Sim.topology.SENSORS).forEach((k) => (col["--s-" + k] = g("--s-" + k)));
  };

  V.init = function (el) {
    canvas = el;
    ctx = canvas.getContext("2d");
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();
    readColors();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener && mq.addEventListener("change", readColors);
    new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    bindPointer();
  };

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
  }

  const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];

  V.fit = function () {
    const ns = Sim.state.nodes;
    if (!ns.length || !W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      let r = 40;
      if (n.role === "gateway" && n.wifi) r = Math.max(r, n.range * Sim.PX_PER_M * 0.75);
      x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r);
      x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r + 20);
    }
    const pad = 30;
    const z = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2 - 30) / (y1 - y0), 1.6);
    view.z = Math.max(0.3, z);
    view.x = W / 2 - ((x0 + x1) / 2) * view.z;
    view.y = H / 2 + 10 - ((y0 + y1) / 2) * view.z;
  };
  V.zoomBy = function (f, sx = W / 2, sy = H / 2) {
    const [wx, wy] = toWorld(sx, sy);
    view.z = Sim.clamp(view.z * f, 0.25, 3);
    view.x = sx - wx * view.z;
    view.y = sy - wy * view.z;
  };
  V.center = () => { const [x, y] = toWorld(W / 2, H / 2); return { x, y }; };

  /* ---------- Hit testing ---------- */
  const nodeRadius = (n) => (n.role === "sensor" ? 15 : n.role === "server" ? 26 : 22);
  function nodeAt(wx, wy) {
    const ns = Sim.state.nodes;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      if (Math.hypot(n.x - wx, n.y - wy) <= nodeRadius(n) + 3) return n;
    }
    return null;
  }
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Sim.clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function linkAt(wx, wy) {
    let best = null, bd = 9 / view.z;
    for (const l of Sim.connections.activeLinks()) {
      const a = Sim.nodeById(l.a), b = Sim.nodeById(l.b);
      if (!a || !b) continue;
      const d = distSeg(wx, wy, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
  function animPos(an) {
    const a = Sim.nodeById(an.fromId), b = Sim.nodeById(an.toId);
    if (!a || !b) return null;
    let p = (Sim.state.now - an.t0) / Math.max(0.001, an.t1 - an.t0);
    p = Sim.clamp(p, 0, 1);
    if (an.dropAt != null) p = Math.min(p, an.dropAt);
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, p };
  }
  function packetAt(wx, wy) {
    for (const an of Sim.state.anims) {
      if (Sim.state.now < an.t0) continue;
      const q = animPos(an);
      if (q && Math.hypot(q.x - wx, q.y - wy) < 8 / view.z + 3) return an;
    }
    return null;
  }

  /* ---------- Pointer ---------- */
  function bindPointer() {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [wx, wy] = toWorld(sx, sy);
      const n = nodeAt(wx, wy);
      if (V.tool === "wire") {
        if (n) { wireFrom = n.id; drag = { type: "wire" }; }
        else drag = { type: "pan", sx, sy, vx: view.x, vy: view.y };
        return;
      }
      const pk = !n && packetAt(wx, wy);
      if (pk) { Sim.ui.openPacketOnLink(pk.pktId, pk.linkId); return; }
      if (n) {
        V.select({ type: "node", id: n.id });
        drag = { type: "node", node: n, dx: wx - n.x, dy: wy - n.y, moved: false };
        return;
      }
      const l = linkAt(wx, wy);
      if (l) { V.select({ type: "link", id: l.id }); Sim.ui.openLink(l.id); return; }
      V.select(null);
      drag = { type: "pan", sx, sy, vx: view.x, vy: view.y };
    });
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [wx, wy] = toWorld(sx, sy);
      pointer = { x: sx, y: sy, wx, wy };
      if (drag && drag.type === "node") {
        drag.node.x = wx - drag.dx;
        drag.node.y = wy - drag.dy;
        drag.moved = true;
        Sim.touch();
      } else if (drag && drag.type === "pan") {
        view.x = drag.vx + (sx - drag.sx);
        view.y = drag.vy + (sy - drag.sy);
      }
      const n = nodeAt(wx, wy);
      V.hover = n ? { type: "node", id: n.id } : packetAt(wx, wy) ? { type: "pkt" } : (() => { const l = linkAt(wx, wy); return l ? { type: "link", id: l.id } : null; })();
      canvas.style.cursor = V.tool === "wire" ? "crosshair" : drag && drag.type === "node" ? "grabbing" : V.hover ? "pointer" : drag ? "grabbing" : "grab";
    });
    const end = (e) => {
      if (drag && drag.type === "wire" && wireFrom) {
        const r = canvas.getBoundingClientRect();
        const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
        const target = nodeAt(wx, wy);
        const a = Sim.nodeById(wireFrom);
        if (target && target !== a) {
          const res = Sim.connections.addWire(a, target);
          if (res.error) Sim.ui.toast(res.error, true);
          else { Sim.ui.toast(`Cable added: ${a.name} ↔ ${target.name}`); V.select({ type: "link", id: res.link.id }); Sim.emit("topology"); }
        }
      }
      if (drag && drag.type === "node" && drag.moved) { Sim.connections.refreshAll(); Sim.emit("topology"); }
      wireFrom = null;
      drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      V.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  V.select = function (s) {
    V.sel = s;
    Sim.emit("select", s);
  };

  /* ---------- Drawing ---------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGrid() {
    const step = 5 * Sim.PX_PER_M; // 5 m
    const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(W, H);
    ctx.lineWidth = 1 / view.z;
    for (let gx = Math.floor(x0 / step) * step; gx < x1; gx += step) {
      ctx.strokeStyle = Math.round(gx / step) % 5 === 0 ? col["--grid-major"] : col["--grid"];
      ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx, y1); ctx.stroke();
    }
    for (let gy = Math.floor(y0 / step) * step; gy < y1; gy += step) {
      ctx.strokeStyle = Math.round(gy / step) % 5 === 0 ? col["--grid-major"] : col["--grid"];
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
    }
  }

  function drawCoverage(g) {
    if (!g.wifi) return;
    const R = g.range * Sim.PX_PER_M;
    ctx.save();
    ctx.globalAlpha = g.enabled ? 1 : 0.35;
    ctx.fillStyle = col["--wifi-soft"];
    ctx.beginPath(); ctx.arc(g.x, g.y, R, 0, Math.PI * 2); ctx.fill();
    // inner rings: where RSSI crosses −70 and −80 dBm
    ctx.strokeStyle = col["--wifi"];
    ctx.lineWidth = 1 / view.z;
    [[-70, 0.18], [-80, 0.28], [-90, 0.7]].forEach(([dbm, a]) => {
      const r = R / Math.pow(10, (dbm + 90) / -30 * -1);
      ctx.globalAlpha = (g.enabled ? 1 : 0.35) * a;
      ctx.setLineDash(dbm === -90 ? [6 / view.z, 5 / view.z] : [2 / view.z, 4 / view.z]);
      ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI * 2); ctx.stroke();
      if (view.z > 0.55 && dbm !== -90) {
        ctx.setLineDash([]);
        ctx.fillStyle = col["--wifi"];
        ctx.font = `500 ${9.5 / Math.max(view.z, 0.8)}px "IBM Plex Mono", monospace`;
        ctx.fillText(`${dbm} dBm`, g.x + r * 0.707 + 3, g.y - r * 0.707);
      }
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = g.enabled ? 0.85 : 0.35;
    ctx.fillStyle = col["--wifi"];
    ctx.font = `600 11px "IBM Plex Sans Condensed", sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`${g.ssid} · ch ${g.channel} · ${g.range} m`, g.x, g.y - R - 6);
    ctx.textAlign = "left";
    ctx.restore();
  }

  function drawLink(l) {
    const a = Sim.nodeById(l.a), b = Sim.nodeById(l.b);
    if (!a || !b) return;
    const selected = V.sel && V.sel.type === "link" && V.sel.id === l.id;
    const hovered = V.hover && V.hover.type === "link" && V.hover.id === l.id;
    const down = !a.enabled || !b.enabled;
    ctx.save();
    if (selected || hovered) {
      ctx.strokeStyle = col["--accent"];
      ctx.globalAlpha = selected ? 0.25 : 0.14;
      ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (l.type === "wifi") {
      ctx.strokeStyle = col["--wifi"];
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -((performance.now() / 60) % 9);
    } else {
      ctx.strokeStyle = down ? col["--bad"] : col["--cable"];
      ctx.lineWidth = Sim.connections.isUplink(l) ? 3 : 2;
      if (down) ctx.setLineDash([3, 5]);
    }
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    // label at midpoint
    // Wi-Fi tags sit nearer the sensor so tags of neighbouring sensors don't collide at the gateway
    const t = l.type === "wifi" ? 0.42 : 0.5;
    const mx = a.x + (b.x - a.x) * t, my = a.y + (b.y - a.y) * t;
    let label = "";
    if (l.type === "wifi") label = `${Sim.connections.rssi(a, b).toFixed(0)} dBm`;
    else if (selected || hovered || Sim.connections.isUplink(l)) label = l.bandwidth >= 1000 ? "1 GbE" : l.bandwidth + " Mb";
    if (label && view.z > 0.45) {
      ctx.font = `500 10px "IBM Plex Mono", monospace`;
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = col["--surface"];
      roundRect(mx - w / 2, my - 8, w, 16, 4); ctx.fill();
      ctx.strokeStyle = l.type === "wifi" ? col["--wifi"] : col["--line-strong"];
      ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = l.type === "wifi" ? col["--wifi"] : col["--ink-2"];
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, mx, my + 0.5);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
  }

  function drawPackets() {
    const st = Sim.state;
    const keep = [];
    for (const an of st.anims) {
      if (st.now > an.t1 + 0.001) {
        if (an.dropAt != null) {
          const q = animPos(an);
          if (q) st.effects.push({ x: q.x, y: q.y, type: "drop", born: performance.now() });
        }
        continue;
      }
      keep.push(an);
      if (st.now < an.t0) continue;
      const q = animPos(an);
      if (!q) continue;
      const c = col["--s-" + an.kind] || col["--accent"];
      const selPkt = Sim.ui.selectedPacketId === an.pktId;
      ctx.beginPath();
      ctx.arc(q.x, q.y, selPkt ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col["--surface"];
      ctx.stroke();
      if (an.retries > 0) {
        ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = col["--warn"]; ctx.lineWidth = 1.5; ctx.stroke();
      }
      if (selPkt) {
        ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = col["--accent"]; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    st.anims = keep;
  }

  function drawEffects() {
    const now = performance.now();
    const st = Sim.state;
    st.effects = st.effects.filter((e) => now - e.born < 900);
    for (const e of st.effects) {
      const k = (now - e.born) / 900;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      if (e.type === "drop") {
        const s = 6 + k * 4;
        ctx.strokeStyle = col["--bad"]; ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(e.x - s, e.y - s); ctx.lineTo(e.x + s, e.y + s);
        ctx.moveTo(e.x + s, e.y - s); ctx.lineTo(e.x - s, e.y + s);
        ctx.stroke();
      } else {
        ctx.strokeStyle = col["--ok"]; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y, 26 + k * 18, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawNode(n) {
    const selected = V.sel && V.sel.type === "node" && V.sel.id === n.id;
    const hovered = V.hover && V.hover.type === "node" && V.hover.id === n.id;
    ctx.save();
    if (selected || hovered) {
      ctx.fillStyle = col["--accent"];
      ctx.globalAlpha = selected ? 0.18 : 0.1;
      ctx.beginPath(); ctx.arc(n.x, n.y, nodeRadius(n) + 9, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    const off = !n.enabled;
    if (n.role === "sensor") {
      const c = col["--s-" + n.kind];
      const orphan = !n.gwId;
      ctx.beginPath(); ctx.arc(n.x, n.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = col["--surface"]; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = off ? col["--ink-3"] : c;
      if (orphan) ctx.setLineDash([3, 3]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = off ? col["--ink-3"] : c;
      ctx.font = `700 13px "IBM Plex Sans Condensed", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(Sim.topology.SENSORS[n.kind].glyph, n.x, n.y + 0.5);
      if (n.conn === "ethernet") { // small port badge
        ctx.fillStyle = col["--cable"];
        roundRect(n.x + 8, n.y + 7, 9, 7, 1.5); ctx.fill();
      }
      if (n.faulty) {
        ctx.fillStyle = col["--warn"];
        ctx.beginPath(); ctx.moveTo(n.x + 11, n.y - 17); ctx.lineTo(n.x + 18, n.y - 5); ctx.lineTo(n.x + 4, n.y - 5); ctx.closePath(); ctx.fill();
      }
      if (orphan && !off) {
        ctx.fillStyle = col["--bad"];
        ctx.font = `600 10px "IBM Plex Sans", sans-serif`;
        ctx.fillText(n.conn === "wifi" ? "no signal" : "no cable", n.x, n.y - 22);
      }
    } else if (n.role === "gateway") {
      ctx.strokeStyle = off ? col["--ink-3"] : col["--ink"];
      ctx.lineWidth = 2;
      if (n.wifi) { // antennas
        ctx.beginPath(); ctx.moveTo(n.x - 10, n.y - 13); ctx.lineTo(n.x - 14, n.y - 26);
        ctx.moveTo(n.x + 10, n.y - 13); ctx.lineTo(n.x + 14, n.y - 26); ctx.stroke();
      }
      roundRect(n.x - 22, n.y - 14, 44, 28, 6);
      ctx.fillStyle = off ? col["--surface-2"] : col["--ink"]; ctx.fill();
      ctx.stroke();
      // status LEDs
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = off ? col["--bad"] : i === 0 ? col["--ok"] : (performance.now() / 180 + i) % 3 < 1.5 && n.queue && n.queue.length ? col["--warn"] : col["--wifi"];
        ctx.beginPath(); ctx.arc(n.x - 11 + i * 7, n.y + 6, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = off ? col["--ink-3"] : col["--surface"];
      ctx.font = `700 10px "IBM Plex Sans Condensed", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("GW", n.x, n.y - 4);
      if (off) {
        ctx.strokeStyle = col["--bad"]; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(n.x - 26, n.y + 18); ctx.lineTo(n.x + 26, n.y - 18); ctx.stroke();
      }
    } else if (n.role === "router") {
      ctx.beginPath(); ctx.arc(n.x, n.y, 20, 0, Math.PI * 2);
      ctx.fillStyle = off ? col["--surface-2"] : col["--ink-2"]; ctx.fill();
      ctx.strokeStyle = col["--surface"]; ctx.lineWidth = 2;
      // classic router symbol: four arrows
      const arr = (dx, dy) => {
        const x0 = n.x + dx * 4, y0 = n.y + dy * 4, x1 = n.x + dx * 13, y1 = n.y + dy * 13;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - dx * 4 - dy * 3, y1 - dy * 4 - dx * 3);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - dx * 4 + dy * 3, y1 - dy * 4 + dx * 3);
        ctx.stroke();
      };
      arr(1, 0); arr(-1, 0); arr(0, 1); arr(0, -1);
    } else {
      // server rack
      ctx.fillStyle = off ? col["--surface-2"] : col["--surface"];
      ctx.strokeStyle = col["--ink"]; ctx.lineWidth = 2;
      roundRect(n.x - 20, n.y - 25, 40, 50, 5); ctx.fill(); ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const y = n.y - 17 + i * 14;
        ctx.strokeStyle = col["--line-strong"]; ctx.lineWidth = 1;
        roundRect(n.x - 14, y, 28, 9, 2); ctx.stroke();
        ctx.fillStyle = col["--ok"];
        ctx.beginPath(); ctx.arc(n.x + 9, y + 4.5, 1.8, 0, Math.PI * 2); ctx.fill();
      }
    }
    // queue gauge beside forwarding nodes
    if (n.queue && (n.queue.length || n.role === "gateway")) {
      const h = 30, x = n.x + (n.role === "router" ? 26 : 28), y = n.y - 15;
      const f = Math.min(1, n.queue.length / n.queueCap);
      ctx.fillStyle = col["--surface-2"]; roundRect(x, y, 6, h, 2); ctx.fill();
      ctx.strokeStyle = col["--line-strong"]; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = f > 0.8 ? col["--bad"] : f > 0.4 ? col["--warn"] : col["--queued"];
      if (f > 0) { roundRect(x, y + h * (1 - f), 6, h * f, 2); ctx.fill(); }
      if (n.queue.length) {
        ctx.fillStyle = col["--ink-2"];
        ctx.font = `500 10px "IBM Plex Mono", monospace`;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(`${n.queue.length}`, x + 9, y + h * (1 - f));
      }
    }
    // labels
    const r = nodeRadius(n);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = off ? col["--ink-3"] : col["--ink"];
    ctx.font = `600 11.5px "IBM Plex Sans Condensed", sans-serif`;
    ctx.fillText(n.name + (off ? " · OFFLINE" : ""), n.x, n.y + r + 5);
    if (view.z > 0.6) {
      ctx.fillStyle = col["--ink-3"];
      ctx.font = `400 10px "IBM Plex Mono", monospace`;
      const ipTxt = n.role === "gateway" ? `${n.ip} | ${n.wanIp}` : n.ip || "no IP";
      ctx.fillText(ipTxt, n.x, n.y + r + 19);
    }
    ctx.restore();
  }

  V.draw = function () {
    if (!ctx || !W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col["--stage"];
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y);
    drawGrid();
    const st = Sim.state;
    st.nodes.filter((n) => n.role === "gateway").forEach(drawCoverage);
    Sim.connections.activeLinks().forEach(drawLink);
    if (wireFrom) {
      const a = Sim.nodeById(wireFrom);
      if (a) {
        ctx.strokeStyle = col["--accent"]; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(pointer.wx, pointer.wy); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    drawPackets();
    st.nodes.forEach(drawNode);
    drawEffects();
    // scale bar (10 m)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const len = 10 * Sim.PX_PER_M * view.z;
    const x = W - len - 16, y = H - 16;
    ctx.strokeStyle = col["--ink-2"]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4); ctx.stroke();
    ctx.fillStyle = col["--ink-2"]; ctx.font = `500 10px "IBM Plex Mono", monospace`; ctx.textAlign = "center";
    ctx.fillText("10 m", x + len / 2, y - 6);
    ctx.textAlign = "left";
  };
})();
