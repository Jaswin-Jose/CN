/* Experiments on the Smart Home network: 120 simulated seconds each, seed 2026.
   Run:  node tests/run-experiments.js        (add --json for machine-readable output) */
const Sim = require("./load");

const SECS = 120;
const experiments = [
  { name: "Normal (baseline)", setup: () => {} },
  { name: "Busy load", setup: () => (Sim.settings.profile = "busy") },
  { name: "Stress load", setup: () => (Sim.settings.profile = "stress") },
  { name: "10% link drop", setup: () => (Sim.settings.extraLoss = 10) },
  { name: "Wi-Fi interference 6 dB", setup: () => (Sim.settings.noise = 6) },
  {
    name: "Gateway down 30–60 s",
    setup: () => {
      const gw = Sim.state.nodes.find((n) => n.name === "GW-1");
      Sim.state.faultPlan = [
        { t: 30000, run: () => Sim.engine.setEnabled(gw, false) },
        { t: 60000, run: () => Sim.engine.setEnabled(gw, true) },
      ];
    },
  },
];

const rows = [];
for (const ex of experiments) {
  Sim.settings = Object.assign({}, Sim.defaults);
  Sim.scenarios.load("home");
  ex.setup();
  Sim.engine.reset();
  const m = Sim.runFor(SECS);
  rows.push({
    experiment: ex.name,
    sent: m.generated,
    received: m.delivered,
    late: m.delayed,
    lost: m.lost,
    lossPct: +(m.lossPct || 0).toFixed(1),
    avgDelayMs: +(m.avgDelay || 0).toFixed(1),
    jitterMs: +(m.jitter || 0).toFixed(1),
    throughput: +m.throughput.toFixed(2),
    retries: m.retries,
    peakQueue: m.peakQueue,
    reasons: Sim.metrics.reasons,
  });
}

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(`Smart Home, ${SECS} s simulated per run, seed ${Sim.defaults.seed}\n`);
  console.table(rows.map(({ reasons, ...r }) => r));
}
