/* sensors.js — Sensor Data Simulation
   Each sensor keeps its own value and drifts with a mean-reverting random
   walk, so readings look like a live environment instead of pure noise. */
(function () {
  const S = (Sim.sensors = {});
  const cat = (n) => Sim.topology.SENSORS[n.kind];

  S.initState = function (node) {
    const c = cat(node);
    node.mean = Sim.uniform(c.init[0], c.init[1]);
    node.value = node.mean;
    node.seqNo = 0;
    node.ipId = Sim.randint(0, 0xffff);
    node.sport = Sim.randint(49152, 65535);  // ephemeral UDP source port
    node.mid = Sim.randint(0, 0xffff);       // CoAP message ID
    node.wlanSeq = Sim.randint(0, 4095);     // 802.11 sequence number
    node.lastReading = null;
  };

  /* Produce the next reading. Faulty sensors occasionally emit a spike far
     outside the physical range, which the gateway rejects. */
  S.read = function (node) {
    const c = cat(node);
    let v;
    if (node.kind === "motion") {
      // occupancy persists: 85% chance of keeping the previous state
      v = Sim.rand() < 0.85 ? node.value : Sim.rand() < 0.3 ? 1 : 0;
    } else {
      node.value += (node.mean - node.value) * 0.03 + Sim.gauss() * c.step;
      if (node.kind === "light" && Sim.rand() < 0.02) node.value += Sim.gauss() * 150; // cloud / lamp switched
      node.value = Sim.clamp(node.value, c.min, c.max);
      v = node.value;
    }
    node.value = v;
    if (node.faulty && Sim.rand() < 0.25) v = Sim.rand() < 0.5 ? c.max * 4 + 17 : c.min - 999;
    const p = Math.pow(10, c.dec);
    v = Math.round(v * p) / p;
    node.seqNo++;
    node.lastReading = { v, t: Sim.state.now };
    return { value: v, unit: c.unit, code: c.code, dec: c.dec };
  };

  /* Generation interval for the next reading, scaled by the load profile
     and by a traffic surge fault. ±15% so sensors don't fire in lockstep. */
  S.nextInterval = function (node) {
    let f = Sim.PROFILES[Sim.settings.profile].factor;
    if (Sim.state.now < Sim.state.surgeUntil) f = Math.min(f, 0.08);
    return node.interval * f * Sim.uniform(0.85, 1.15);
  };

  S.format = function (kind, v) {
    const c = Sim.topology.SENSORS[kind];
    if (kind === "motion") return v ? "motion" : "clear";
    return v.toFixed(c.dec) + (c.unit ? " " + c.unit : "");
  };
})();
