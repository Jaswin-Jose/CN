/* topology.js — Node Manager (IoT Topology & Node Modeling)
   Device catalogue, node creation/removal, MAC and IP addressing, DHCP. */
(function () {
  const T = (Sim.topology = {});

  /* Sensor catalogue. Ranges are the plausible physical limits that the
     gateway uses to validate readings. OUIs are real vendor prefixes. */
  T.SENSORS = {
    temperature: { label: "Temperature", short: "TMP", glyph: "T", unit: "°C", code: "C", min: -20, max: 60, init: [21, 25], step: 0.12, interval: 2000, dec: 1, vendor: "Espressif", oui: [0x24, 0x0a, 0xc4], chip: "ESP32 + DHT22" },
    humidity: { label: "Humidity", short: "HUM", glyph: "H", unit: "%RH", code: "%RH", min: 0, max: 100, init: [42, 58], step: 0.5, interval: 3000, dec: 1, vendor: "Espressif", oui: [0x24, 0x0a, 0xc4], chip: "ESP32 + DHT22" },
    light: { label: "Light", short: "LUX", glyph: "L", unit: "lx", code: "lx", min: 0, max: 100000, init: [220, 480], step: 18, interval: 1500, dec: 0, vendor: "Espressif", oui: [0x24, 0x0a, 0xc4], chip: "ESP8266 + BH1750" },
    motion: { label: "Motion (PIR)", short: "PIR", glyph: "M", unit: "", code: "bool", min: 0, max: 1, init: [0, 0], step: 0, interval: 1200, dec: 0, vendor: "Espressif", oui: [0x24, 0x0a, 0xc4], chip: "ESP32 + HC-SR501" },
    air: { label: "Air quality (CO₂)", short: "CO2", glyph: "A", unit: "ppm", code: "ppm", min: 300, max: 10000, init: [480, 650], step: 9, interval: 3000, dec: 0, vendor: "Espressif", oui: [0x24, 0x0a, 0xc4], chip: "ESP32 + SCD40" },
    soil: { label: "Soil moisture", short: "SOIL", glyph: "S", unit: "%VWC", code: "%VWC", min: 0, max: 60, init: [24, 34], step: 0.2, interval: 4000, dec: 1, vendor: "RaspberryPi", oui: [0x28, 0xcd, 0xc1], chip: "Pico W + capacitive probe" },
    vibration: { label: "Vibration", short: "VIB", glyph: "V", unit: "mm/s", code: "mm/s", min: 0, max: 50, init: [1.8, 3.2], step: 0.15, interval: 800, dec: 2, vendor: "TexasInstrum", oui: [0x00, 0x12, 0x4b], chip: "CC3235 + ADXL355" },
  };
  T.INFRA = {
    gateway: { label: "IoT gateway", short: "GW", vendor: "RaspberryPi", oui: [0xb8, 0x27, 0xeb], chip: "Raspberry Pi 4 · Wi-Fi AP + router + NAT" },
    router: { label: "Router", short: "R", vendor: "Cisco", oui: [0x00, 0x1b, 0x54], chip: "Edge router" },
    server: { label: "Cloud server", short: "CLOUD", vendor: "Dell", oui: [0x00, 0x14, 0x22], chip: "CoAP server, udp/5683" },
  };

  let uid = 0;
  const counters = {};
  const usedMacs = new Set();

  function makeMac(oui) {
    let mac;
    do {
      const b = [...oui, Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
      mac = b.map((x) => x.toString(16).padStart(2, "0")).join(":");
    } while (usedMacs.has(mac));
    usedMacs.add(mac);
    return mac;
  }
  T.makeMac = makeMac;

  function nextName(kind, short, pad) {
    counters[kind] = (counters[kind] || 0) + 1;
    return short + "-" + String(counters[kind]).padStart(pad, "0");
  }

  T.countOf = (role) => Sim.state.nodes.filter((n) => n.role === role).length;

  /* Create a node. kind = a sensor type, "gateway", "router" or "server". */
  T.addNode = function (kind, x, y, opts = {}) {
    const st = Sim.state;
    const sensorCat = T.SENSORS[kind];
    const base = { id: "n" + ++uid, kind, x, y, enabled: true, stats: {} };
    let node;
    if (sensorCat) {
      node = Object.assign(base, {
        role: "sensor",
        name: opts.name || nextName(kind, sensorCat.short, 2),
        mac: makeMac(sensorCat.oui),
        conn: opts.conn || "wifi",
        interval: opts.interval || sensorCat.interval,
        faulty: !!opts.faulty,
        ip: null,          // leased by DHCP when it joins a gateway
        gwId: null,        // gateway it is attached to
        wifiLinkId: null,  // active Wi-Fi association link
      });
    } else if (kind === "gateway") {
      const i = counters.gwNet = (counters.gwNet || 0) + 1;
      node = Object.assign(base, {
        role: "gateway",
        name: opts.name || nextName(kind, "GW", 1),
        lanMac: makeMac(T.INFRA.gateway.oui),   // wlan0/eth0 — also the Wi-Fi BSSID
        wanMac: makeMac(T.INFRA.gateway.oui),   // eth1 uplink
        wifi: opts.wifi !== false,
        range: opts.range || 30,                 // metres
        channel: [1, 6, 11][(i - 1) % 3],
        ssid: "IoT-Lab-" + i,
        lanNet: "192.168." + (9 + i),
        wanIp: "198.51.100." + (10 + i),
        queueCap: opts.queueCap || 24,
        procTime: opts.procTime || 6,            // ms per packet
      });
      node.mac = node.lanMac;
      node.ip = node.lanNet + ".1";
    } else if (kind === "router") {
      const i = (counters.rIp = (counters.rIp || 0) + 1);
      node = Object.assign(base, {
        role: "router",
        name: opts.name || nextName(kind, "R", 1),
        mac: makeMac(T.INFRA.router.oui),
        ip: "10.0.0." + i,
        queueCap: opts.queueCap || 64,
        procTime: opts.procTime || 1.5,
      });
    } else {
      const i = (counters.sIp = (counters.sIp || 0) + 1);
      node = Object.assign(base, {
        role: "server",
        name: opts.name || nextName(kind, "CLOUD", 1),
        mac: makeMac(T.INFRA.server.oui),
        ip: "203.0.113." + (9 + i),
        port: 5683,
      });
    }
    T.resetRuntime(node);
    st.nodes.push(node);
    Sim.touch();
    return node;
  };

  /* Per-run state that Reset clears (topology itself is kept). */
  T.resetRuntime = function (node) {
    node.stats = { sent: 0, delivered: 0, delayed: 0, lost: 0, delaySum: 0, forwarded: 0, dropped: 0, peakQueue: 0, received: 0 };
    if (node.role === "gateway" || node.role === "router") {
      node.queue = [];
      node.busy = false;
    }
    if (node.role === "gateway") {
      node.leases = {};
      node.dhcpNext = 100;
      node.nat = {};
      node.natNext = 40000;
    }
    if (node.role === "server") node.store = {};
    if (node.role === "sensor") {
      node.ip = null;
      node.gwId = null;
      node.wifiLinkId = null;
    }
  };

  T.removeNode = function (node) {
    const st = Sim.state;
    st.links = st.links.filter((l) => l.a !== node.id && l.b !== node.id);
    st.nodes = st.nodes.filter((n) => n !== node);
    node.removed = true;
    st.anims = st.anims.filter((a) => a.fromId !== node.id && a.toId !== node.id);
    usedMacs.delete(node.mac);
    Sim.touch();
    Sim.connections.refreshAll();
  };

  T.clear = function () {
    Sim.state.nodes = [];
    Sim.state.links = [];
    for (const k in counters) delete counters[k];
    usedMacs.clear();
    Sim.touch();
  };

  /* DHCP: lease an address from the gateway's LAN pool (192.168.x.100+). */
  T.dhcpLease = function (gw, sensor) {
    if (!gw.leases[sensor.id]) gw.leases[sensor.id] = gw.lanNet + "." + gw.dhcpNext++;
    return gw.leases[sensor.id];
  };

  T.vendorOf = function (mac) {
    const nodes = Sim.state.nodes;
    for (const n of nodes) {
      if (n.mac === mac || n.lanMac === mac || n.wanMac === mac) {
        const cat = T.SENSORS[n.kind] || T.INFRA[n.role];
        return cat.vendor;
      }
    }
    return "";
  };
  /* Wireshark-style resolved MAC, e.g. "Espressif_3a:10:f2 (24:0a:c4:3a:10:f2)" */
  T.macName = function (mac, withRaw = true) {
    const v = T.vendorOf(mac);
    const short = v ? v + "_" + mac.slice(9) : mac;
    return withRaw && v ? `${short} (${mac})` : short;
  };

  T.colorOf = function (node) {
    return node.role === "sensor" ? `--s-${node.kind}` : "--ink";
  };

  T.nearest = function (x, y, pred) {
    let best = null, bd = Infinity;
    for (const n of Sim.state.nodes) {
      if (!pred(n)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
})();
