/* Loads the simulator modules into Node (no browser needed) for tests and experiments. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

global.window = global;
global.performance = { now: () => Date.now() };
const root = path.join(__dirname, "..", "js");
for (const f of ["core", "topology", "connections", "sensors", "protocol", "routing", "logger", "metrics", "engine", "scenarios"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f + ".js"), "utf8"), { filename: f + ".js" });
}

/* Run the loaded scenario for `secs` simulated seconds in 100 ms steps. */
Sim.runFor = function (secs) {
  for (let i = 0; i < secs * 10; i++) Sim.engine.advance(100);
  return Sim.metrics.compute();
};

module.exports = Sim;
