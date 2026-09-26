/* logger.js — Event Logging & Report Generation
   Time-ordered record of what happened in the network, plus file exports. */
(function () {
  const L = (Sim.log = {});
  const MAX = 4000;
  L.items = [];
  L.total = 0;

  L.add = function (type, text, meta = {}) {
    L.items.push({ t: Sim.state.now, type, text, ...meta, n: ++L.total });
    if (L.items.length > MAX) L.items.splice(0, L.items.length - MAX);
  };
  L.reset = function () { L.items = []; L.total = 0; };

  L.asText = function () {
    return L.items.map((e) => `[${Sim.fmt.clock(e.t)}] ${e.type.toUpperCase().padEnd(8)} ${e.text}`).join("\n");
  };

  /* Save a file. Opened locally: a normal browser download. Opened as a
     hosted claude.ai page: the viewer's "downloads" capability, which asks
     the viewer to confirm and doesn't accept .pcap, so captures are
     wrapped in a .zip there. Resolves true when the file was handed over. */
  let dl = null;
  L.download = async function (name, data, mime) {
    if (window.claude && window.claude.use) {
      if (!dl) dl = await window.claude.use("downloads").catch(() => null);
      if (!dl) { Sim.ui.toast("Saving files isn't available in this view. Open the local copy to export.", true); return false; }
      let filename = name, payload = data;
      if (/\.pcap$/.test(name)) {
        filename = name + ".zip";
        payload = L.zipStore(name, new Uint8Array(await data.arrayBuffer()));
      }
      try { await dl.save({ filename, data: payload }); return true; }
      catch (e) {
        if (e && e.code === "declined") return false;
        Sim.ui.toast(e && e.code === "rate_limited" ? "A save prompt is already open." : "Couldn't save the file in this view.", true);
        return false;
      }
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  };

  /* Minimal ZIP writer (one file, stored without compression). */
  L.zipStore = function (name, bytes) {
    const nm = new TextEncoder().encode(name);
    const crc = Sim.protocol.crc32(bytes);
    const buf = new ArrayBuffer(30 + nm.length + bytes.length + 46 + nm.length + 22);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let o = 0;
    const w32 = (v) => { dv.setUint32(o, v >>> 0, true); o += 4; };
    const w16 = (v) => { dv.setUint16(o, v, true); o += 2; };
    w32(0x04034b50); w16(20); w16(0); w16(0); w16(0); w16(0x21); w32(crc); w32(bytes.length); w32(bytes.length); w16(nm.length); w16(0);
    u8.set(nm, o); o += nm.length; u8.set(bytes, o); o += bytes.length;
    const cd = o;
    w32(0x02014b50); w16(20); w16(20); w16(0); w16(0); w16(0); w16(0x21); w32(crc); w32(bytes.length); w32(bytes.length); w16(nm.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(0);
    u8.set(nm, o); o += nm.length;
    const cdSize = o - cd;
    w32(0x06054b50); w16(0); w16(0); w16(1); w16(1); w32(cdSize); w32(cd); w16(0);
    return buf;
  };

  L.packetsCsv = function () {
    const head = ["no", "sensor", "type", "value", "unit", "src_ip", "dst_ip", "created_s", "done_s", "status", "delay_ms", "hops", "retries", "frame_bytes", "drop_reason"];
    const rows = Sim.state.packets.map((p) => [
      p.id, p.sensorName, p.kind, p.value, p.unit, p.origSrc, p.ip.dst, (p.created / 1000).toFixed(3),
      p.doneAt == null ? "" : (p.doneAt / 1000).toFixed(3), p.status,
      p.delay == null ? "" : p.delay.toFixed(2), p.hops.length, p.retries, p.firstLen || "", p.dropReason || "",
    ]);
    return [head, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  };
})();
