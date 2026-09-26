/* connections.js — Network Connection Management
   Ethernet cables (create / validate / delete) and Wi-Fi association with a
   log-distance radio model. */
(function () {
  const C = (Sim.connections = {});
  let lid = 0;

  function newLink(type, a, b) {
    return {
      id: (type === "wifi" ? "w" : "e") + ++lid,
      type, a: a.id, b: b.id,
      bandwidth: type === "wifi" ? 24 : a.role === "sensor" || b.role === "sensor" ? 100 : 1000, // Mbit/s
      latency: null,   // ms override; null = use global setting
      loss: 0,         // % extra loss on this link only
      busyUntil: {},
      stats: null,
      captures: [],
      frameNo: 0,
      lastActive: -1e9,
    };
  }
  C.resetRuntime = function (link) {
    link.busyUntil = {};
    link.stats = { frames: 0, bytes: 0, lost: 0, retries: 0, ok: 0, latSum: 0 };
    link.captures = [];
    link.frameNo = 0;
    link.lastActive = -1e9;
  };

  C.isUplink = (link) => {
    const a = Sim.nodeById(link.a), b = Sim.nodeById(link.b);
    return link.type === "ethernet" && a && b && a.role !== "sensor" && b.role !== "sensor";
  };
  C.other = (link, node) => Sim.nodeById(link.a === node.id ? link.b : link.a);
  C.label = (link) => {
    const a = Sim.nodeById(link.a), b = Sim.nodeById(link.b);
    return `${a ? a.name : "?"} ↔ ${b ? b.name : "?"}`;
  };

  /* Rules for a physical cable. Returns an error message or "" if valid. */
  C.validateWire = function (a, b) {
    if (!a || !b) return "Pick two devices.";
    if (a === b) return "A device can't be cabled to itself.";
    const exists = Sim.state.links.some((l) => l.type === "ethernet" && ((l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id)));
    if (exists) return `${a.name} and ${b.name} are already cabled.`;
    const roles = [a.role, b.role].sort().join("-");
    if (roles === "sensor-sensor") return "Sensors don't forward traffic. Cable each sensor to a gateway.";
    if (roles === "router-sensor" || roles === "sensor-server") return "Sensors must connect through a gateway, not directly to a " + (roles.includes("router") ? "router." : "server.");
    if (roles === "server-server") return "Two servers can't be cabled together here.";
    const s = a.role === "sensor" ? a : b.role === "sensor" ? b : null;
    if (s && Sim.state.links.some((l) => l.type === "ethernet" && (l.a === s.id || l.b === s.id)))
      return `${s.name} already has a cable. Delete it first to move the sensor to another gateway.`;
    return "";
  };

  C.addWire = function (a, b) {
    const err = C.validateWire(a, b);
    if (err) return { error: err };
    const link = newLink("ethernet", a, b);
    C.resetRuntime(link);
    Sim.state.links.push(link);
    const s = a.role === "sensor" ? a : b.role === "sensor" ? b : null;
    if (s && s.conn !== "ethernet") {
      s.conn = "ethernet";
      C.dropWifi(s);
    }
    if (s) C.attach(s, s === a ? b : a, "ethernet");
    Sim.touch();
    return { link };
  };

  C.removeLink = function (link) {
    Sim.state.links = Sim.state.links.filter((l) => l !== link);
    Sim.state.anims = Sim.state.anims.filter((an) => an.linkId !== link.id);
    for (const id of [link.a, link.b]) {
      const n = Sim.nodeById(id);
      if (n && n.role === "sensor" && link.type === "ethernet") { n.gwId = null; n.ip = null; }
    }
    Sim.touch();
  };

  C.wireOf = (sensor) => Sim.state.links.find((l) => l.type === "ethernet" && (l.a === sensor.id || l.b === sensor.id)) || null;

  /* ---------- Radio model ----------
     RSSI(d) = −90 dBm at the configured range edge, rising 30 dB per decade
     closer (log-distance path loss, exponent n = 3 for indoor spaces).
     Packet error rate follows a logistic curve around −86 dBm. */
  C.distanceM = (a, b) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) / Sim.PX_PER_M);
  C.noiseNow = () => Sim.settings.noise + (Sim.state.now < Sim.state.interferenceUntil ? 10 : 0);
  C.rssi = function (sensor, gw) {
    const d = C.distanceM(sensor, gw);
    return Math.min(-30, -90 + 30 * Math.log10(gw.range / d)) - C.noiseNow();
  };
  C.per = (rssi) => 1 / (1 + Math.exp((rssi + 86) / 1.6));
  C.quality = (rssi) => (rssi >= -60 ? "Excellent" : rssi >= -70 ? "Good" : rssi >= -80 ? "Fair" : rssi >= -88 ? "Weak" : "Unusable");

  C.gatewaysInRange = function (sensor) {
    return Sim.state.nodes
      .filter((g) => g.role === "gateway" && g.enabled && g.wifi && C.distanceM(sensor, g) <= g.range)
      .map((g) => ({ g, rssi: C.rssi(sensor, g) }))
      .sort((a, b) => b.rssi - a.rssi);
  };

  function wifiLinkFor(sensor, gw) {
    let link = Sim.state.links.find((l) => l.type === "wifi" && l.a === sensor.id && l.b === gw.id);
    if (!link) {
      link = newLink("wifi", sensor, gw);
      C.resetRuntime(link);
      Sim.state.links.push(link);
    }
    return link;
  }

  C.dropWifi = function (sensor) {
    if (sensor.wifiLinkId) {
      const l = Sim.linkById(sensor.wifiLinkId);
      if (l) l.active = false;
    }
    sensor.wifiLinkId = null;
  };

  /* Record the sensor's attachment to a gateway and lease an IP. */
  C.attach = function (sensor, gw, how, rssi) {
    if (sensor.gwId === gw.id && sensor.ip) return;
    sensor.gwId = gw.id;
    sensor.ip = Sim.topology.dhcpLease(gw, sensor);
    if (how === "wifi") Sim.log.add("assoc", `${sensor.name} associated with ${gw.ssid} on ${gw.name} (RSSI ${rssi.toFixed(0)} dBm, ch ${gw.channel})`, { nodeId: sensor.id });
    else Sim.log.add("assoc", `${sensor.name} link up on ${gw.name} eth0 (100BASE-TX full duplex)`, { nodeId: sensor.id });
    Sim.log.add("dhcp", `DHCP ACK ${gw.name} → ${sensor.name}: ${sensor.ip}/24, router ${gw.ip}`, { nodeId: sensor.id });
  };

  /* Wi-Fi association with 6 dB hysteresis so sensors don't flap between
     two gateways of similar strength. */
  C.associate = function (sensor) {
    if (sensor.conn !== "wifi") return;
    const cands = C.gatewaysInRange(sensor);
    const cur = sensor.wifiLinkId ? Sim.linkById(sensor.wifiLinkId) : null;
    const curGw = cur ? Sim.nodeById(cur.b) : null;
    const curEntry = curGw ? cands.find((c) => c.g === curGw) : null;
    let pick = cands[0] || null;
    if (curEntry && pick && pick.g !== curGw && pick.rssi - curEntry.rssi < 6) pick = curEntry;
    if (!pick) {
      if (cur || sensor.gwId) {
        Sim.log.add("assoc", `${sensor.name} lost Wi-Fi association (no gateway in range)`, { nodeId: sensor.id });
        C.dropWifi(sensor);
        sensor.gwId = null;
        sensor.ip = null;
        Sim.touch();
      }
      return;
    }
    if (!cur || pick.g !== curGw) {
      C.dropWifi(sensor);
      const link = wifiLinkFor(sensor, pick.g);
      link.active = true;
      sensor.wifiLinkId = link.id;
      sensor.gwId = null;
      C.attach(sensor, pick.g, "wifi", pick.rssi);
      Sim.touch();
    }
  };

  C.refreshAll = function () {
    for (const n of Sim.state.nodes) {
      if (n.role !== "sensor") continue;
      if (n.conn === "wifi") C.associate(n);
      else {
        const w = C.wireOf(n);
        const gw = w ? C.other(w, n) : null;
        if (gw && gw.role === "gateway" && gw.enabled) C.attach(n, gw, "ethernet");
        else if (!gw) { n.gwId = null; n.ip = null; }
      }
    }
  };

  /* Change a sensor between Wi-Fi and Ethernet. Ethernet cables it to the
     nearest gateway automatically. */
  C.setConn = function (sensor, conn) {
    if (sensor.conn === conn) return "";
    if (conn === "ethernet") {
      const gw = Sim.topology.nearest(sensor.x, sensor.y, (n) => n.role === "gateway");
      if (!gw) return "Add a gateway first, then cable the sensor to it.";
      C.dropWifi(sensor);
      sensor.gwId = null; sensor.ip = null;
      sensor.conn = "ethernet";
      const r = C.addWire(sensor, gw);
      if (r.error) return r.error;
    } else {
      const w = C.wireOf(sensor);
      if (w) C.removeLink(w);
      sensor.conn = "wifi";
      sensor.gwId = null; sensor.ip = null;
      C.associate(sensor);
    }
    Sim.touch();
    return "";
  };

  C.activeLinks = () => Sim.state.links.filter((l) => l.type === "ethernet" || l.active);
})();
