/* Test cases that validate the simulator on the Smart Home network.
   Run:  node tests/run-tests.js */
const Sim = require("./load");

const results = [];
function test(name, fn) {
  Sim.settings = Object.assign({}, Sim.defaults);
  Sim.scenarios.load("home");
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const sensors = () => Sim.state.nodes.filter((n) => n.role === "sensor");
const byName = (n) => Sim.state.nodes.find((x) => x.name === n);

function sum16(b, s, e, x = 0) {
  for (let i = s; i < e; i += 2) x += (b[i] << 8) + (i + 1 < e ? b[i + 1] : 0);
  while (x >>> 16) x = (x & 0xffff) + (x >>> 16);
  return x;
}

test("TC1 Every sensor generates readings", () => {
  Sim.runFor(30);
  const silent = sensors().filter((s) => s.stats.sent === 0);
  expect(!silent.length, "silent sensors: " + silent.map((s) => s.name));
  return `${sensors().length} sensors, all sent packets`;
});

test("TC2 Every sensor gets an IP address by DHCP", () => {
  const missing = sensors().filter((s) => !s.ip || !s.ip.startsWith("192.168.10."));
  expect(!missing.length, "no IP: " + missing.map((s) => s.name));
  return sensors().map((s) => `${s.name}=${s.ip}`).join(", ");
});

test("TC3 Checksums in every received frame are correct (IPv4, UDP, CRC-32 FCS)", () => {
  Sim.runFor(40);
  let n = 0;
  for (const l of Sim.state.links) for (const f of l.captures) {
    if (f.lost) continue;
    n++;
    const b = f.bytes, ip = l.type === "wifi" ? 32 : 14;
    expect(sum16(b, ip, ip + 20) === 0xffff, `bad IPv4 checksum, link ${l.id} frame ${f.no}`);
    const len = (b[ip + 2] << 8) | b[ip + 3];
    const pseudo = [...b.slice(ip + 12, ip + 20), 0, 17, b[ip + 24], b[ip + 25]];
    expect(sum16(b, ip + 20, ip + len, sum16(pseudo, 0, 12)) === 0xffff, `bad UDP checksum, frame ${f.no}`);
    const fcs = (b[b.length - 4] | (b[b.length - 3] << 8) | (b[b.length - 2] << 16) | (b[b.length - 1] << 24)) >>> 0;
    expect(Sim.protocol.crc32(b, 0, b.length - 4) === fcs, `bad FCS, frame ${f.no}`);
  }
  return `${n} frames checked`;
});

test("TC4 Packets are conserved: sent = received + lost + in flight", () => {
  const m = Sim.runFor(60);
  expect(m.generated === m.delivered + m.lost + m.inFlight, "counts don't add up");
  return `${m.generated} = ${m.delivered} + ${m.lost} + ${m.inFlight}`;
});

test("TC5 Same seed gives identical results", () => {
  Sim.runFor(30);
  const a = JSON.stringify(Sim.metrics.c);
  Sim.engine.reset();
  Sim.runFor(30);
  expect(a === JSON.stringify(Sim.metrics.c), "runs differ");
  return "two runs matched exactly";
});

test("TC6 100% link drop probability delivers nothing", () => {
  Sim.settings.extraLoss = 100;
  const m = Sim.runFor(20);
  expect(m.delivered === 0 && m.lost > 0, `delivered ${m.delivered}`);
  return `${m.lost} lost, 0 received`;
});

test("TC7 NAT and TTL: packets reach the server from the gateway's public IP with TTL 62", () => {
  Sim.runFor(20);
  const p = Sim.state.packets.find((x) => x.status === "delivered" || x.status === "delayed");
  expect(p, "no delivered packet");
  const gw = byName("GW-1");
  expect(p.ip.src === gw.wanIp, `source is ${p.ip.src}`);
  expect(p.ip.ttl === 62, `TTL is ${p.ip.ttl}`);
  return `${p.origSrc}:${p.origSport} → ${p.ip.src}:${p.udp.sport}, TTL 64 → ${p.ip.ttl}`;
});

test("TC8 Gateway failure: packets are lost while offline and flow again after recovery", () => {
  Sim.runFor(10);
  const gw = byName("GW-1");
  Sim.engine.setEnabled(gw, false);
  const before = Sim.metrics.c.delivered;
  Sim.runFor(10);
  const duringLost = (Sim.metrics.reasons.noroute || 0) + (Sim.metrics.reasons.offline || 0);
  expect(duringLost > 0, "no packets lost while gateway offline");
  expect(Sim.metrics.c.delivered - before <= 2, "packets still delivered while offline");
  Sim.engine.setEnabled(gw, true);
  const d2 = Sim.metrics.c.delivered;
  Sim.runFor(10);
  expect(Sim.metrics.c.delivered > d2, "no recovery");
  return `${duringLost} lost while offline, ${Sim.metrics.c.delivered - d2} received after recovery`;
});

test("TC9 Stress load produces many more packets than Normal", () => {
  const normal = Sim.runFor(30).generated;
  Sim.settings.profile = "stress";
  Sim.engine.reset();
  const stress = Sim.runFor(30).generated;
  expect(stress >= normal * 5, `normal ${normal}, stress ${stress}`);
  return `normal ${normal} vs stress ${stress} packets in 30 s`;
});

test("TC10 A slow, full gateway queue drops packets (tail drop)", () => {
  const gw = byName("GW-1");
  gw.procTime = 60;
  gw.queueCap = 5;
  Sim.settings.profile = "stress";
  Sim.engine.reset();
  Sim.runFor(20);
  expect((Sim.metrics.reasons.queue || 0) > 0, "no queue drops");
  return `${Sim.metrics.reasons.queue} queue-overflow drops, peak queue ${Sim.metrics.c.peakQueue}`;
});

test("TC11 Faulty sensor spikes are rejected by gateway validation", () => {
  byName("TMP-LIVING").faulty = true;
  Sim.runFor(40);
  expect((Sim.metrics.reasons.validation || 0) > 0, "nothing rejected");
  return `${Sim.metrics.reasons.validation} readings rejected`;
});

test("TC12 A sensor moved out of Wi-Fi range loses its connection", () => {
  const s = byName("SOIL-GARDEN"), gw = byName("GW-1");
  s.x = gw.x + 60 * Sim.PX_PER_M; // 60 m away, range is 32 m
  Sim.runFor(10);
  expect(!s.wifiLinkId && s.stats.delivered === 0, "still connected");
  return `${s.name} not associated, ${s.stats.lost} packets lost`;
});

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} test cases passed`);
process.exitCode = pass === results.length ? 0 : 1;
