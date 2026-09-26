/* routing.js — Packet Routing & Forwarding
   Hop-by-hop shortest-path routing toward the nearest reachable server,
   plus the gateway's NAT (private 192.168.x.x → public WAN address). */
(function () {
  const R = (Sim.routing = {});

  /* Neighbours a node can transmit to right now. Sensors never forward,
     so they only appear as the first node of a path. */
  R.neighbors = function (node) {
    const out = [];
    for (const l of Sim.state.links) {
      if (l.type === "ethernet") {
        if (l.a !== node.id && l.b !== node.id) continue;
      } else {
        // a Wi-Fi association is only usable in the uplink direction
        if (!l.active || l.a !== node.id) continue;
      }
      const to = Sim.connections.other(l, node);
      if (to && to.enabled) out.push({ link: l, to });
    }
    return out;
  };

  /* Breadth-first search: returns the first hop {link, to} of the shortest
     path to any enabled server, or null if no route exists. */
  R.nextHop = function (start) {
    const path = R.path(start);
    return path ? path.hops[0] : null;
  };

  R.path = function (start) {
    const seen = new Set([start.id]);
    const q = [{ node: start, hops: [] }];
    while (q.length) {
      const cur = q.shift();
      if (cur.node.role === "server" && cur.hops.length) return { server: cur.node, hops: cur.hops };
      if (cur.node.role === "sensor" && cur.node !== start) continue;
      for (const nb of R.neighbors(cur.node)) {
        if (seen.has(nb.to.id)) continue;
        seen.add(nb.to.id);
        q.push({ node: nb.to, hops: cur.hops.concat([nb]) });
      }
    }
    return null;
  };

  R.describe = function (start) {
    const p = R.path(start);
    if (!p) return null;
    return [start.name, ...p.hops.map((h) => h.to.name)];
  };

  R.inLan = (gw, ip) => ip && ip.startsWith(gw.lanNet + ".");

  /* Source NAT at the gateway (like a home router): the private
     address:port is rewritten to the gateway's public WAN address and a
     port from its translation table. */
  R.nat = function (gw, pkt) {
    if (!R.inLan(gw, pkt.ip.src)) return null;
    const key = pkt.ip.src + ":" + pkt.udp.sport;
    if (!gw.nat[key]) gw.nat[key] = gw.natNext++;
    const entry = { inside: key, outside: gw.wanIp + ":" + gw.nat[key], gw: gw.name };
    pkt.ip.src = gw.wanIp;
    pkt.udp.sport = gw.nat[key];
    return entry;
  };
})();
