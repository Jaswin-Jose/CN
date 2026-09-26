/* main.js — System Integration: boots every module and runs the frame loop. */
(function () {
  function boot() {
    Sim.render.init(document.getElementById("canvas"));
    Sim.ui.init();
    Sim.scenarios.load("home");
    requestAnimationFrame(() => Sim.render.fit());
    Sim.ui.setRunning(true);

    let last = performance.now();
    function frame(ts) {
      const dt = Math.min(100, ts - last); // clamp after tab switches
      last = ts;
      if (Sim.state.running) Sim.engine.advance(dt * Sim.settings.speed);
      Sim.render.draw();
      Sim.ui.tick(ts);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
