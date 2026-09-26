/* metrics.js — Network Metrics & Performance Analysis
     Packet loss %    = lost ÷ (received + lost) × 100
     Delivery rate %  = received ÷ (received + lost) × 100
     Average delay    = Σ end-to-end delay of received packets ÷ received
     Jitter           = standard deviation of end-to-end delay
     Throughput       = received packets ÷ simulated seconds
   Packets still in flight are excluded until they finish. */
(function () {
  const M = (Sim.metrics = {});

  M.reset = function () {
    M.c = { generated: 0, forwarded: 0, delivered: 0, delayed: 0, lost: 0, retries: 0, frames: 0, delaySum: 0, delaySq: 0, bytes: 0, peakQueue: 0 };
    M.reasons = {};
    M.buckets = [];  // one per simulated second
    M.snapshots = M.snapshots || [];
  };
  M.reset();

  function bucket(t) {
    const i = Math.floor(t / 1000);
    while (M.buckets.length <= i) M.buckets.push({ gen: 0, del: 0, lost: 0, dsum: 0, q: 0 });
    return M.buckets[i];
  }

  M.onGenerated = (p) => { M.c.generated++; bucket(p.created).gen++; };
  M.onForward = () => { M.c.forwarded++; };
  M.onFrame = (retry) => { M.c.frames++; if (retry) M.c.retries++; };
  M.onDelivered = (p) => {
    M.c.delivered++;
    if (p.status === "delayed") M.c.delayed++;
    M.c.delaySum += p.delay;
    M.c.delaySq += p.delay * p.delay;
    M.c.bytes += p.payloadLen;
    const b = bucket(p.doneAt);
    b.del++;
    b.dsum += p.delay;
  };
  M.onLost = (p, reasonKey) => {
    M.c.lost++;
    M.reasons[reasonKey] = (M.reasons[reasonKey] || 0) + 1;
    bucket(p.doneAt).lost++;
  };
  M.onQueue = (node) => {
    const q = node.queue.length;
    if (q > node.stats.peakQueue) node.stats.peakQueue = q;
    if (q > M.c.peakQueue) M.c.peakQueue = q;
  };

  M.queueNow = () => Sim.state.nodes.reduce((s, n) => s + (n.queue ? n.queue.length : 0), 0);
  M.sample = function (now) {
    const b = bucket(now);
    b.q = Math.max(b.q, M.queueNow());
  };

  M.compute = function () {
    const c = M.c;
    const done = c.delivered + c.lost;
    const secs = Math.max(Sim.state.now / 1000, 0.001);
    const avg = c.delivered ? c.delaySum / c.delivered : null;
    const jitter = c.delivered > 1 ? Math.sqrt(Math.max(0, c.delaySq / c.delivered - avg * avg)) : null;
    // traffic intensity: packets generated per second over the last 5 s
    const n = M.buckets.length;
    let recent = 0, span = 0;
    for (let i = Math.max(0, n - 6); i < n - 1; i++) { recent += M.buckets[i].gen; span++; }
    return {
      generated: c.generated,
      forwarded: c.forwarded,
      delivered: c.delivered,
      delayed: c.delayed,
      onTime: c.delivered - c.delayed,
      lost: c.lost,
      inFlight: c.generated - done,
      lossPct: done ? (c.lost / done) * 100 : null,
      deliveryPct: done ? (c.delivered / done) * 100 : null,
      avgDelay: avg,
      jitter,
      throughput: c.delivered / secs,
      goodputKbps: (c.bytes * 8) / 1000 / secs,
      intensity: span ? recent / span : c.generated / secs,
      queueNow: M.queueNow(),
      peakQueue: c.peakQueue,
      retries: c.retries,
      frames: c.frames,
      secs,
    };
  };

  /* Last `n` seconds of a per-second series for sparklines. */
  M.series = function (key, n = 60) {
    const out = [];
    const end = Math.max(0, M.buckets.length - 1); // skip the partial current second
    for (let i = Math.max(0, end - n); i < end; i++) {
      const b = M.buckets[i];
      out.push(key === "delay" ? (b.del ? b.dsum / b.del : null) : key === "del" ? b.del : key === "lost" ? b.lost : b.q);
    }
    return out;
  };

  M.snapshot = function () {
    const s = Sim.settings;
    const r = M.compute();
    const snap = {
      n: M.snapshots.length + 1,
      scenario: Sim.state.scenarioLabel || "Custom",
      profile: Sim.PROFILES[s.profile].label,
      devices: Sim.state.nodes.filter((x) => x.role === "sensor").length,
      gatewaysUp: Sim.state.nodes.filter((x) => x.role === "gateway" && x.enabled).length + "/" + Sim.state.nodes.filter((x) => x.role === "gateway").length,
      extraLoss: s.extraLoss,
      noise: s.noise,
      latency: `${s.wifiLatency}/${s.wiredLatency}/${s.uplinkLatency}`,
      seed: s.seed,
      ...r,
      reasons: Object.assign({}, M.reasons),
    };
    M.snapshots.push(snap);
    return snap;
  };
})();
