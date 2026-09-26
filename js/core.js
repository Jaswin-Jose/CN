/* core.js — shared namespace, seeded random numbers, event queue, settings.
   Every other module attaches itself to window.Sim. */
(function () {
  const Sim = (window.Sim = window.Sim || {});

  /* ---------- Seeded PRNG (mulberry32) ----------
     Using a fixed seed makes experiments repeatable: same scenario + same
     seed + same settings = the same packets, the same losses. */
  let state = 1;
  Sim.reseed = function (seed) { state = (seed >>> 0) || 1; };
  Sim.rand = function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Sim.uniform = (a, b) => a + Sim.rand() * (b - a);
  Sim.randint = (a, b) => Math.floor(a + Sim.rand() * (b - a + 1));
  Sim.gauss = function () {
    let u = 0;
    while (u === 0) u = Sim.rand();
    const v = Sim.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  Sim.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- Units ---------- */
  Sim.PX_PER_M = 8; // 8 canvas pixels = 1 metre
  // Simulation starts at 28 Sep 2026 09:00:00 UTC (submission day), so packet
  // timestamps look like real capture times.
  Sim.EPOCH_MS = Date.UTC(2026, 8, 28, 9, 0, 0);

  /* ---------- Settings (edited by the control panel) ---------- */
  Sim.defaults = {
    speed: 0.25,          // simulated seconds per real second
    profile: "normal",    // normal | busy | stress
    extraLoss: 0,         // % drop probability added to every transmission
    wifiLatency: 60,      // ms base latency of a Wi-Fi hop
    wiredLatency: 10,     // ms base latency of a sensor Ethernet hop
    uplinkLatency: 90,    // ms base latency of gateway/router/server links
    jitter: 25,           // ± % random variation on each hop
    delayThreshold: 300,  // ms — delivered later than this counts as "delayed"
    retryLimit: 3,        // 802.11 MAC retransmissions per frame
    noise: 0,             // dB of extra interference on all Wi-Fi links
    seed: 2026,
  };
  Sim.settings = Object.assign({}, Sim.defaults);

  Sim.PROFILES = {
    normal: { label: "Normal", factor: 1 },
    busy: { label: "Busy", factor: 0.4 },
    stress: { label: "Stress", factor: 0.1 },
  };

  /* ---------- Shared state ---------- */
  Sim.state = {
    now: 0,             // simulated milliseconds since start
    running: false,
    nodes: [],
    links: [],
    packets: [],        // every packet generated this run
    anims: [],          // packets currently drawn on a link
    effects: [],        // short-lived drop / delivery marks
    pktSeq: 0,
    topoVersion: 0,
    surgeUntil: -1,
    interferenceUntil: -1,
    scenario: "",
  };
  Sim.nodeById = (id) => Sim.state.nodes.find((n) => n.id === id) || null;
  Sim.linkById = (id) => Sim.state.links.find((l) => l.id === id) || null;
  Sim.touch = () => { Sim.state.topoVersion++; };

  /* ---------- Min-heap event queue ---------- */
  class EventQueue {
    constructor() { this.h = []; this.n = 0; }
    clear() { this.h = []; }
    get size() { return this.h.length; }
    push(t, fn) {
      const e = { t, k: this.n++, fn };
      const h = this.h;
      h.push(e);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.less(h[p], h[i])) break;
        [h[p], h[i]] = [h[i], h[p]];
        i = p;
      }
    }
    less(a, b) { return a.t < b.t || (a.t === b.t && a.k < b.k); }
    peek() { return this.h[0]; }
    pop() {
      const h = this.h;
      const top = h[0];
      const last = h.pop();
      if (h.length) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < h.length && this.less(h[l], h[m])) m = l;
          if (r < h.length && this.less(h[r], h[m])) m = r;
          if (m === i) break;
          [h[m], h[i]] = [h[i], h[m]];
          i = m;
        }
      }
      return top;
    }
  }
  Sim.EventQueue = EventQueue;

  /* ---------- Tiny pub/sub so UI can react to model changes ---------- */
  const subs = {};
  Sim.on = (evt, fn) => { (subs[evt] = subs[evt] || []).push(fn); };
  Sim.emit = (evt, data) => { (subs[evt] || []).forEach((fn) => fn(data)); };

  /* ---------- Formatting helpers ---------- */
  Sim.fmt = {
    hex2: (n) => (n & 0xff).toString(16).padStart(2, "0"),
    hex4: (n) => (n & 0xffff).toString(16).padStart(4, "0"),
    hex8: (n) => (n >>> 0).toString(16).padStart(8, "0"),
    ms: (v) => (v == null || !isFinite(v) ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + " s" : v.toFixed(1) + " ms"),
    pct: (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(1) + "%"),
    clock(ms) {
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const r = Math.floor(ms % 1000);
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
    },
    secs: (ms) => (ms / 1000).toFixed(3),
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  };
})();
