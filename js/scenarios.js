/* scenarios.js — Scenario Builder (Smart Home) and Fault & Stress module
   The Smart Home network used for every experiment, plus fault injectors.
   Test cases that validate it live in tests/run-tests.js. */
(function () {
  const SC = (Sim.scenarios = {});
  const T = () => Sim.topology;
  const M = Sim.PX_PER_M;

  const at = (gw, meters, deg) => [gw.x + Math.cos((deg * Math.PI) / 180) * meters * M, gw.y + Math.sin((deg * Math.PI) / 180) * meters * M];
  function sensor(kind, gw, meters, deg, opts) {
    const [x, y] = at(gw, meters, deg);
    return T().addNode(kind, x, y, opts);
  }
  function wire(a, b) { Sim.connections.addWire(a, b); }

  SC.list = [
    {
      id: "home",
      label: "Smart Home",
      about: "One Wi-Fi gateway behind an ISP router. The garden soil sensor sits near the edge of Wi-Fi range, so expect retries and some radio loss.",
      build() {
        const gw = T().addNode("gateway", 540, 390, { range: 32 });
        const r = T().addNode("router", 830, 390, { name: "ISP-R1" });
        const cloud = T().addNode("server", 1080, 390);
        wire(gw, r); wire(r, cloud);
        sensor("temperature", gw, 14, 195, { name: "TMP-LIVING" });
        sensor("humidity", gw, 16, 140, { name: "HUM-BATH" });
        sensor("light", gw, 18, 240, { name: "LUX-HALL" });
        sensor("motion", gw, 16, 300, { name: "PIR-DOOR" });
        sensor("air", gw, 21, 100, { name: "CO2-KITCH" });
        sensor("soil", gw, 27, 160, { name: "SOIL-GARDEN" });
        const t2 = T().addNode("temperature", 690, 545, { name: "TMP-SERVER", conn: "ethernet" });
        wire(t2, gw);
      },
    },
  ];

  SC.byName = (name) => Sim.state.nodes.find((n) => n.name === name) || null;

  SC.load = function (id = "home") {
    const sc = SC.list.find((s) => s.id === id) || SC.list[0];
    const speed = Sim.settings.speed;
    Sim.settings = Object.assign({}, Sim.defaults, { speed }, sc.settings || {});
    T().clear();
    sc.build();
    Sim.state.scenario = sc.id;
    Sim.state.scenarioLabel = sc.label;
    Sim.state.scenarioAbout = sc.about;
    Sim.state.faultPlan = sc.faults || [];
    Sim.engine.reset();
    Sim.emit("scenario", sc);
  };

  /* ---------- Fault & stress injectors ---------- */
  SC.trafficSurge = function (secs = 10) {
    Sim.state.surgeUntil = Sim.state.now + secs * 1000;
    Sim.log.add("fault", `Traffic surge: every sensor reports ~12× faster for ${secs} s`);
  };
  SC.interference = function (secs = 10) {
    Sim.state.interferenceUntil = Sim.state.now + secs * 1000;
    Sim.log.add("fault", `Radio interference: −10 dB on every Wi-Fi link for ${secs} s`);
  };
  SC.failRandomGateway = function (secs = 15) {
    const gws = Sim.state.nodes.filter((n) => n.role === "gateway" && n.enabled);
    if (!gws.length) return null;
    const g = gws[Math.floor(Math.random() * gws.length)];
    Sim.engine.setEnabled(g, false);
    const gen = Sim.engine.gen;
    Sim.engine.after(secs * 1000, () => { if (gen === Sim.engine.gen && !g.removed) Sim.engine.setEnabled(g, true); });
    return g;
  };
})();
