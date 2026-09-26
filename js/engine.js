/* engine.js — Simulation Engine + Packet Controller
   Discrete-event simulation: every sensor reading, link transmission,
   gateway queue step and arrival is an event on a time-ordered queue.
   Packet life: created → travelling → (queued at gateway) → travelling → delivered | delayed | dropped */
(function () {
  const E = (Sim.engine = {});
  const Q = new Sim.EventQueue();
  E.gen = 1; // bumps on reset so stale scheduled events are ignored

  E.at = (t, fn) => Q.push(t, fn);
  E.after = (dt, fn) => Q.push(Sim.state.now + dt, fn);
  E.pending = () => Q.size;

  E.advance = function (dtSim) {
    const st = Sim.state;
    const target = st.now + dtSim;
    let e;
    let guard = 0;
    while ((e = Q.peek()) && e.t <= target && guard++ < 50000) {
      Q.pop();
      st.now = e.t;
      e.fn();
    }
    st.now = target;
    Sim.metrics.sample(st.now);
  };

  /* ---------- Helpers ---------- */
  const macOut = (from, to) => (from.role === "gateway" ? (to.role === "sensor" ? from.lanMac : from.wanMac) : from.mac);
  const macIn = (to, from) => (to.role === "gateway" ? (from.role === "sensor" ? to.lanMac : to.wanMac) : to.mac);
  const effect = (node, type) => node && Sim.state.effects.push({ x: node.x, y: node.y, type, born: performance.now() });
  const note = (pkt, type, text) => pkt.journey.push({ t: Sim.state.now, type, text });

  function drop(pkt, reason, key, atNode) {
    if (pkt.status === "dropped" || pkt.status === "delivered" || pkt.status === "delayed") return;
    const st = Sim.state;
    pkt.status = "dropped";
    pkt.dropReason = reason;
    pkt.doneAt = st.now;
    pkt.dropKey = key;
    note(pkt, "drop", reason);
    const s = Sim.nodeById(pkt.sensorId);
    if (s) s.stats.lost++;
    if (atNode) { atNode.stats.dropped++; effect(atNode, "drop"); }
    Sim.metrics.onLost(pkt, key);
    Sim.log.add("drop", `#${pkt.id} ${pkt.sensorName} dropped — ${reason}`, { pktId: pkt.id });
  }
  E.drop = drop;

  /* ---------- 1. Sensor update + 2. packet creation ---------- */
  function generate(node) {
    const st = Sim.state;
    if (node.conn === "wifi") Sim.connections.associate(node);
    const r = Sim.sensors.read(node);
    const path = Sim.routing.path(node);
    const server = path ? path.server : st.nodes.find((n) => n.role === "server");
    node.ipId = (node.ipId + 1) & 0xffff;
    node.mid = (node.mid + 1) & 0xffff;
    const json = { dev: node.name, type: node.kind, v: r.value, u: r.code, seq: node.seqNo, ts: Math.floor((Sim.EPOCH_MS + st.now) / 1000) };
    const pkt = {
      id: ++st.pktSeq,
      sensorId: node.id, sensorName: node.name, kind: node.kind,
      value: r.value, unit: r.unit,
      created: st.now, status: "travelling",
      hops: [], retries: 0, journey: [],
      ip: { src: node.ip || "0.0.0.0", dst: server ? server.ip : "203.0.113.10", ttl: 64, id: node.ipId },
      udp: { sport: node.sport, dport: 5683 },
      coap: { mid: node.mid, token: [Sim.randint(0, 255), Sim.randint(0, 255)], path: node.name.toLowerCase() },
      json, delay: null, doneAt: null, dropReason: null, nat: null,
    };
    pkt.origSrc = pkt.ip.src;
    pkt.origSport = pkt.udp.sport;
    pkt.payloadLen = Sim.protocol.buildJson(json).text.length;
    st.packets.push(pkt);
    if (st.packets.length > 6000) st.packets.splice(0, st.packets.length - 6000);
    node.stats.sent++;
    Sim.metrics.onGenerated(pkt);
    note(pkt, "create", `Reading ${Sim.sensors.format(node.kind, r.value)} wrapped in CoAP POST /sensors/${pkt.coap.path}`);
    Sim.log.add("create", `#${pkt.id} ${node.name} read ${Sim.sensors.format(node.kind, r.value)} → packet to ${pkt.ip.dst}`, { pktId: pkt.id });

    if (!path) {
      let why;
      if (node.conn === "wifi") why = node.wifiLinkId ? "No route from the gateway to a server" : "Not associated — no Wi-Fi gateway in range";
      else why = Sim.connections.wireOf(node) ? "No route to a server (gateway offline or not connected)" : "No cable connected";
      drop(pkt, why, "noroute", node);
      return;
    }
    sendHop(pkt, node, path.hops[0]);
  }

  /* ---------- 3. Network check: loss, delay, 802.11 retries ---------- */
  function sendHop(pkt, from, hop) {
    const st = Sim.state, s = Sim.settings;
    const link = hop.link, to = hop.to;
    const wifi = link.type === "wifi";
    const base = link.latency != null ? link.latency : wifi ? s.wifiLatency : Sim.connections.isUplink(link) ? s.uplinkLatency : s.wiredLatency;
    const rssi = wifi ? Sim.connections.rssi(from, to) : null;
    const per = wifi ? Sim.connections.per(rssi) : 0;
    const pLoss = 1 - (1 - per) * (1 - s.extraLoss / 100) * (1 - link.loss / 100);
    const attempts = wifi ? s.retryLimit + 1 : 1;
    const l2 = {
      medium: link.type,
      src: macOut(from, to),
      dst: macIn(to, from),
      bssid: wifi ? to.lanMac : null,
      wlanSeq: wifi ? (from.wlanSeq = (from.wlanSeq + 1) & 0xfff) : 0,
    };
    const dir = from.id;
    let t = Math.max(st.now, link.busyUntil[dir] || 0);
    const rec = {
      linkId: link.id, fromId: from.id, toId: to.id, fromName: from.name, toName: to.name,
      medium: link.type, tStart: t, tEnd: 0, attempts: 0, ok: false, frames: [], rssi, per, ttl: pkt.ip.ttl, src: pkt.ip.src, sport: pkt.udp.sport,
    };
    let lastStart = t, txTime = 0;
    for (let i = 0; i < attempts; i++) {
      const lost = Sim.rand() < pLoss;
      const frame = Sim.protocol.encode(pkt, Object.assign({}, l2, { retry: i > 0, corrupt: lost }));
      txTime = (frame.len * 8) / (link.bandwidth * 1000); // ms
      const lat = (i === 0 ? base : base * 0.5) * (1 + ((Sim.rand() * 2 - 1) * s.jitter) / 100);
      const cap = Object.assign(frame, {
        no: ++link.frameNo, linkId: link.id, medium: link.type, pktId: pkt.id, time: t, lost, retry: i > 0, attempt: i + 1,
        srcName: from.name, dstName: to.name, src: pkt.ip.src, dst: pkt.ip.dst, sport: pkt.udp.sport, ttl: pkt.ip.ttl,
      });
      link.captures.push(cap);
      if (link.captures.length > 500) link.captures.shift();
      link.stats.frames++;
      link.stats.bytes += frame.len;
      if (lost) link.stats.lost++;
      if (i > 0) { link.stats.retries++; pkt.retries++; }
      Sim.metrics.onFrame(i > 0);
      rec.frames.push(cap);
      rec.attempts++;
      if (!pkt.firstLen) pkt.firstLen = frame.len;
      lastStart = t;
      t += txTime + Math.max(0.05, lat);
      if (!lost) { rec.ok = true; break; }
    }
    link.busyUntil[dir] = lastStart + txTime;
    rec.tEnd = t;
    pkt.hops.push(rec);
    pkt.status = "travelling";
    pkt.at = { linkId: link.id };
    const how = wifi ? `Wi-Fi ch ${to.channel}, RSSI ${rssi.toFixed(0)} dBm` : `Ethernet ${link.bandwidth >= 1000 ? "1 Gbit/s" : link.bandwidth + " Mbit/s"}`;
    note(pkt, "tx", `${from.name} → ${to.name} over ${how}${rec.attempts > 1 ? ` · ${rec.attempts} attempts` : ""}`);
    st.anims.push({ pktId: pkt.id, kind: pkt.kind, linkId: link.id, fromId: from.id, toId: to.id, t0: rec.tStart, t1: t, dropAt: rec.ok ? null : Sim.uniform(0.45, 0.8), retries: rec.attempts - 1 });

    const gen = E.gen;
    E.at(t, () => {
      if (gen !== E.gen) return;
      if (!Sim.linkById(link.id) && link.type === "ethernet") return drop(pkt, `Cable ${from.name}–${to.name} was removed while the packet was on it`, "link", null);
      if (rec.ok) {
        link.stats.ok++;
        link.stats.latSum += t - rec.tStart;
        arrive(pkt, to, link);
      } else if (wifi) {
        drop(pkt, `Lost on Wi-Fi ${from.name} → ${to.name} after ${rec.attempts} attempts (RSSI ${rssi.toFixed(0)} dBm, frame error rate ${(per * 100).toFixed(0)}%)`, "radio", null);
      } else {
        drop(pkt, `Lost on cable ${from.name} → ${to.name} (bit errors, FCS check failed)`, "link", null);
      }
    });
  }

  /* ---------- 4. Gateway processing / 5. server arrival ---------- */
  function arrive(pkt, node, link) {
    if (node.removed) return drop(pkt, `${node.name} was removed from the network`, "offline", null);
    if (!node.enabled) return drop(pkt, `${node.name} is offline`, "offline", node);
    note(pkt, "rx", `Received by ${node.name}`);
    if (node.role === "server") return deliver(pkt, node);
    const prev = Sim.connections.other(link, node);
    if (node.role === "gateway" && (link.type === "wifi" || (prev && prev.role === "sensor"))) {
      const c = Sim.topology.SENSORS[pkt.kind];
      if (!isFinite(pkt.value) || pkt.value < c.min || pkt.value > c.max) {
        return drop(pkt, `Rejected by ${node.name} validation: ${pkt.value} ${c.unit} is outside the sensor's range (${c.min} to ${c.max})`, "validation", node);
      }
    }
    if (node.role === "gateway" || node.role === "router") return enqueue(node, pkt);
    drop(pkt, `${node.name} does not forward packets`, "noroute", node);
  }

  function enqueue(node, pkt) {
    if (node.queue.length >= node.queueCap) {
      return drop(pkt, `Queue overflow at ${node.name} (${node.queueCap}/${node.queueCap} full, tail drop)`, "queue", node);
    }
    node.queue.push(pkt);
    pkt.status = "queued";
    pkt.at = { nodeId: node.id };
    Sim.metrics.onQueue(node);
    note(pkt, "queue", `Queued at ${node.name} (position ${node.queue.length} of ${node.queueCap})`);
    Sim.log.add("queue", `#${pkt.id} queued at ${node.name} (depth ${node.queue.length}/${node.queueCap})`, { pktId: pkt.id });
    service(node);
  }

  function service(node) {
    if (node.busy || !node.queue.length) return;
    node.busy = true;
    const pkt = node.queue.shift();
    const gen = E.gen;
    E.after(node.procTime * Sim.uniform(0.8, 1.2), () => {
      if (gen !== E.gen) return;
      node.busy = false;
      if (node.removed) return drop(pkt, `${node.name} was removed from the network`, "offline", null);
      if (!node.enabled) drop(pkt, `${node.name} went offline while processing the packet`, "offline", node);
      else forward(node, pkt);
      service(node);
    });
  }

  function forward(node, pkt) {
    pkt.ip.ttl--;
    if (pkt.ip.ttl <= 0) return drop(pkt, "TTL expired in transit", "ttl", node);
    let nat = "";
    if (node.role === "gateway") {
      const e = Sim.routing.nat(node, pkt);
      if (e) { pkt.nat = e; nat = ` · NAT ${e.inside} → ${e.outside}`; }
      node.stats.forwarded++;
      Sim.metrics.onForward();
    } else node.stats.forwarded++;
    const hop = Sim.routing.nextHop(node);
    if (!hop) return drop(pkt, `No route from ${node.name} to a server`, "noroute", node);
    note(pkt, "forward", `${node.name} forwarded to ${hop.to.name}, TTL ${pkt.ip.ttl + 1} → ${pkt.ip.ttl}${nat}`);
    Sim.log.add("forward", `#${pkt.id} ${node.name} → ${hop.to.name} (TTL ${pkt.ip.ttl})${nat}`, { pktId: pkt.id });
    sendHop(pkt, node, hop);
  }

  function deliver(pkt, server) {
    const st = Sim.state;
    pkt.delay = st.now - pkt.created;
    pkt.status = pkt.delay > Sim.settings.delayThreshold ? "delayed" : "delivered";
    pkt.doneAt = st.now;
    pkt.at = { nodeId: server.id };
    server.stats.received++;
    server.store[pkt.sensorId] = { name: pkt.sensorName, kind: pkt.kind, value: pkt.value, t: st.now, delay: pkt.delay, id: pkt.id };
    const s = Sim.nodeById(pkt.sensorId);
    if (s) {
      s.stats.delivered++;
      s.stats.delaySum += pkt.delay;
      if (pkt.status === "delayed") s.stats.delayed++;
    }
    note(pkt, pkt.status === "delayed" ? "delay" : "deliver", `Delivered to ${server.name} in ${pkt.delay.toFixed(1)} ms${pkt.status === "delayed" ? ` (over the ${Sim.settings.delayThreshold} ms threshold)` : ""}`);
    Sim.metrics.onDelivered(pkt);
    effect(server, "deliver");
    Sim.log.add(pkt.status === "delayed" ? "delay" : "deliver", `#${pkt.id} ${pkt.sensorName} delivered to ${server.name} in ${pkt.delay.toFixed(1)} ms${pkt.status === "delayed" ? " (late)" : ""}`, { pktId: pkt.id });
  }

  /* ---------- Sensor timers ---------- */
  E.scheduleSensor = function (node) {
    if (node.schedGen === E.gen) return;
    node.schedGen = E.gen;
    const gen = E.gen;
    const fire = () => {
      if (gen !== E.gen || node.removed) return;
      if (node.enabled) generate(node);
      E.after(Sim.sensors.nextInterval(node), fire);
    };
    E.after(Sim.uniform(0.05, 1) * Sim.sensors.nextInterval(node), fire);
  };

  /* ---------- Node availability (fault module uses this) ---------- */
  E.setEnabled = function (node, on) {
    if (node.enabled === on) return;
    node.enabled = on;
    if (!on && node.queue) {
      const flushed = node.queue.splice(0);
      flushed.forEach((p) => drop(p, `${node.name} went offline, queued packet discarded`, "offline", node));
    }
    Sim.log.add("fault", `${node.name} is now ${on ? "ONLINE" : "OFFLINE"}`, { nodeId: node.id });
    Sim.touch();
    Sim.connections.refreshAll();
    Sim.emit("topology");
  };

  /* ---------- Reset: same topology, fresh run ---------- */
  E.reset = function () {
    const st = Sim.state;
    E.gen++;
    Q.clear();
    st.now = 0;
    st.packets = [];
    st.anims = [];
    st.effects = [];
    st.pktSeq = 0;
    st.surgeUntil = -1;
    st.interferenceUntil = -1;
    Sim.reseed(Sim.settings.seed);
    Sim.log.reset();
    Sim.metrics.reset();
    for (const n of st.nodes) {
      Sim.topology.resetRuntime(n);
      if (n.role === "sensor") Sim.sensors.initState(n);
    }
    st.links = st.links.filter((l) => l.type === "ethernet");
    st.links.forEach(Sim.connections.resetRuntime);
    Sim.log.add("info", `Run started · scenario ${st.scenarioLabel || "custom"} · seed ${Sim.settings.seed}`);
    Sim.connections.refreshAll();
    for (const n of st.nodes) if (n.role === "sensor") E.scheduleSensor(n);
    (st.faultPlan || []).forEach((f) => {
      const gen = E.gen;
      E.at(f.t, () => { if (gen === E.gen) f.run(); });
    });
    Sim.touch();
    Sim.emit("reset");
  };
})();
