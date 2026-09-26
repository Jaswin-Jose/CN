/* protocol.js — Packet encoding and dissection
   Builds the actual bytes a packet has on each link:
     Wi-Fi hop:     IEEE 802.11 data frame + LLC/SNAP + IPv4 + UDP + CoAP + JSON + FCS
     Ethernet hop:  Ethernet II + IPv4 + UDP + CoAP + JSON + FCS
   Checksums (IPv4 header, UDP with pseudo-header, CRC-32 FCS) are computed
   for real, so exported .pcap files open correctly in Wireshark. */
(function () {
  const P = (Sim.protocol = {});
  const F = Sim.fmt;

  /* ---------- Checksums ---------- */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  P.crc32 = function (b, start = 0, end = b.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  function sum16(b, start, end, s = 0) {
    for (let i = start; i < end; i += 2) s += (b[i] << 8) + (i + 1 < end ? b[i + 1] : 0);
    return s;
  }
  const fold = (s) => { while (s >>> 16) s = (s & 0xffff) + (s >>> 16); return ~s & 0xffff; };

  const ipBytes = (ip) => ip.split(".").map(Number);
  const macBytes = (m) => m.split(":").map((h) => parseInt(h, 16));
  const ascii = (s) => Array.from(new TextEncoder().encode(s));

  /* ---------- Byte writer that remembers which field owns which bytes ---------- */
  class Writer {
    constructor() { this.b = []; this.layers = []; this.cur = null; }
    get off() { return this.b.length; }
    layer(title, proto) {
      if (this.cur) this.cur.end = this.off;
      this.cur = { title, proto, start: this.off, end: this.off, fields: [] };
      this.layers.push(this.cur);
      return this.cur;
    }
    put(label, arr) {
      const f = { label, off: this.off, len: arr.length };
      for (const x of arr) this.b.push(x & 0xff);
      this.cur.fields.push(f);
      return f;
    }
    u8(l, v) { return this.put(l, [v]); }
    u16(l, v) { return this.put(l, [v >> 8, v]); }
    u16le(l, v) { return this.put(l, [v, v >> 8]); }
    u32(l, v) { return this.put(l, [v >>> 24, v >>> 16, v >>> 8, v]); }
    set16(off, v) { this.b[off] = (v >> 8) & 0xff; this.b[off + 1] = v & 0xff; }
    close() { if (this.cur) this.cur.end = this.off; }
  }

  /* JSON body built member-by-member so each key/value maps to exact bytes. */
  P.buildJson = function (obj) {
    let s = "{";
    const members = [];
    Object.entries(obj).forEach(([k, v], i) => {
      if (i) s += ",";
      const piece = JSON.stringify(k) + ":" + JSON.stringify(v);
      members.push({ k, v, off: new TextEncoder().encode(s).length, len: new TextEncoder().encode(piece).length });
      s += piece;
    });
    s += "}";
    return { text: s, members };
  };

  /* hop = { medium:"wifi"|"ethernet", src, dst, bssid, retry, wlanSeq }
     pkt.ip / pkt.udp / pkt.coap / pkt.json hold the current header values
     (TTL and NAT change as the packet moves). */
  P.encode = function (pkt, hop) {
    const w = new Writer();
    const json = P.buildJson(pkt.json);
    const body = ascii(json.text);
    const seg = pkt.coap.path;
    const coapLen = 4 + 2 + 8 + (1 + seg.length) + 2 + 1 + body.length;
    const udpLen = 8 + coapLen;
    const ipLen = 20 + udpLen;
    const protos = [];

    /* ----- Layer 2 ----- */
    if (hop.medium === "wifi") {
      const L = w.layer("", "wlan");
      protos.push("wlan", "llc");
      const flags = 0x01 | (hop.retry ? 0x08 : 0);
      w.u8("Frame Control Field: Type/Subtype: Data (0x0020)", 0x08);
      w.u8(`Flags: 0x${F.hex2(flags)} — DS status: To DS (1)${hop.retry ? ", Retry: frame is being retransmitted" : ""}`, flags);
      w.u16le("Duration/ID: 44 microseconds", 44);
      w.put(`Receiver / BSS Id: ${Sim.topology.macName(hop.bssid)}`, macBytes(hop.bssid));
      w.put(`Transmitter / Source address: ${Sim.topology.macName(hop.src)}`, macBytes(hop.src));
      w.put(`Destination address: ${Sim.topology.macName(hop.dst)}`, macBytes(hop.dst));
      w.u16le(`Sequence number: ${hop.wlanSeq}, Fragment number: 0`, hop.wlanSeq << 4);
      L.title = `IEEE 802.11 Data, Flags: ${hop.retry ? "....R..T" : ".......T"}`;
      const LL = w.layer("Logical-Link Control", "llc");
      w.put("DSAP: SNAP (0xaa), SSAP: SNAP (0xaa)", [0xaa, 0xaa]);
      w.u8("Control field: U, func=UI (0x03)", 0x03);
      w.put("Organization Code: 00:00:00 (Officially Xerox, but …)", [0, 0, 0]);
      w.u16("Type: IPv4 (0x0800)", 0x0800);
      LL.title = "Logical-Link Control";
    } else {
      const L = w.layer("", "eth");
      protos.push("eth", "ethertype");
      w.put(`Destination: ${Sim.topology.macName(hop.dst)}`, macBytes(hop.dst));
      w.put(`Source: ${Sim.topology.macName(hop.src)}`, macBytes(hop.src));
      w.u16("Type: IPv4 (0x0800)", 0x0800);
      L.title = `Ethernet II, Src: ${Sim.topology.macName(hop.src, false)}, Dst: ${Sim.topology.macName(hop.dst, false)}`;
    }

    /* ----- IPv4 ----- */
    const ip = pkt.ip;
    const ipStart = w.off;
    w.layer(`Internet Protocol Version 4, Src: ${ip.src}, Dst: ${ip.dst}`, "ip");
    protos.push("ip");
    w.u8("0100 .... = Version: 4 · .... 0101 = Header Length: 20 bytes (5)", 0x45);
    w.u8("Differentiated Services Field: 0x00 (DSCP: CS0, ECN: Not-ECT)", 0x00);
    w.u16(`Total Length: ${ipLen}`, ipLen);
    w.u16(`Identification: 0x${F.hex4(ip.id)} (${ip.id})`, ip.id);
    w.u16("Flags: 0x2, Don't fragment · Fragment Offset: 0", 0x4000);
    w.u8(`Time to Live: ${ip.ttl}`, ip.ttl);
    w.u8("Protocol: UDP (17)", 17);
    const ipCk = w.u16("Header Checksum", 0);
    w.put(`Source Address: ${ip.src}`, ipBytes(ip.src));
    w.put(`Destination Address: ${ip.dst}`, ipBytes(ip.dst));
    const ipSum = fold(sum16(w.b, ipStart, ipStart + 20));
    w.set16(ipCk.off, ipSum);
    ipCk.label = `Header Checksum: 0x${F.hex4(ipSum)} [correct]`;
    ipCk.good = true;

    /* ----- UDP ----- */
    const udpStart = w.off;
    w.layer(`User Datagram Protocol, Src Port: ${pkt.udp.sport}, Dst Port: ${pkt.udp.dport}`, "udp");
    protos.push("udp");
    w.u16(`Source Port: ${pkt.udp.sport}`, pkt.udp.sport);
    w.u16(`Destination Port: ${pkt.udp.dport} (CoAP)`, pkt.udp.dport);
    w.u16(`Length: ${udpLen}`, udpLen);
    const udpCk = w.u16("Checksum", 0);

    /* ----- CoAP (RFC 7252) ----- */
    const c = pkt.coap;
    w.layer(`Constrained Application Protocol, Non-Confirmable, POST, MID:${c.mid}`, "coap");
    protos.push("coap");
    w.u8("01.. .... = Version: 1 · ..01 .... = Type: Non-Confirmable (1) · .... 0010 = Token Length: 2", 0x52);
    w.u8("Code: POST (2)", 0x02);
    w.u16(`Message ID: ${c.mid}`, c.mid);
    w.put(`Token: ${c.token.map(F.hex2).join("")}`, c.token);
    w.put("Opt Name: #1: Uri-Path: sensors", [0xb7, ...ascii("sensors")]);
    w.put(`Opt Name: #2: Uri-Path: ${seg}`, [seg.length, ...ascii(seg)]);
    w.put("Opt Name: #3: Content-Format: application/json (50)", [0x11, 50]);
    w.u8("Payload Marker: 0xff", 0xff);

    /* ----- JSON payload ----- */
    const jStart = w.off;
    w.layer(`JavaScript Object Notation: application/json (${body.length} bytes)`, "json");
    protos.push("json");
    const jf = w.put("Payload", body);
    w.cur.fields.pop(); // replace the whole-body field with one field per member
    w.cur.fields.push({ label: "Object", off: jf.off, len: 1 });
    for (const m of json.members) w.cur.fields.push({ label: `Member: ${m.k} = ${JSON.stringify(m.v)}`, off: jStart + m.off, len: m.len });
    w.close();

    // UDP checksum over pseudo-header + UDP header + data
    const pseudo = [...ipBytes(ip.src), ...ipBytes(ip.dst), 0, 17, udpLen >> 8, udpLen & 0xff];
    let us = fold(sum16(w.b, udpStart, w.off, sum16(pseudo, 0, pseudo.length)));
    if (us === 0) us = 0xffff;
    w.set16(udpCk.off, us);
    udpCk.label = `Checksum: 0x${F.hex4(us)} [correct]`;
    udpCk.good = true;

    const noFcs = w.b.slice();
    let fcs = P.crc32(noFcs);
    const bytes = noFcs.slice();

    // A frame damaged by radio noise / bit errors: flip one bit in the payload
    // so the receiver's FCS check fails (that is why it is discarded).
    let fcsOk = true;
    if (hop.corrupt) {
      const i = Sim.randint(udpStart, bytes.length - 1);
      bytes[i] ^= 1 << Sim.randint(0, 7);
      fcsOk = false;
      fcs = P.crc32(noFcs); // sender's FCS stays the original
    }
    const l2 = w.layers[0];
    l2.fields.push({
      label: fcsOk ? `Frame check sequence: 0x${F.hex8(fcs)} [correct]` : `Frame check sequence: 0x${F.hex8(fcs)} [incorrect, should be 0x${F.hex8(P.crc32(bytes))}]`,
      off: bytes.length, len: 4, good: fcsOk, bad: !fcsOk,
    });
    bytes.push(fcs & 0xff, (fcs >>> 8) & 0xff, (fcs >>> 16) & 0xff, (fcs >>> 24) & 0xff); // FCS is sent LSB first

    return {
      bytes: new Uint8Array(bytes),
      layers: w.layers,
      protos: protos.join(":"),
      fcsOk,
      len: bytes.length,
      info: `NON, MID:${c.mid}, POST, TKN:${c.token.map(F.hex2).join("")}, /sensors/${seg}`,
    };
  };

  /* ---------- pcap export (libpcap format, microsecond timestamps) ----------
     Frames are written without the FCS, which is how Wireshark expects
     LINKTYPE_ETHERNET (1) and LINKTYPE_IEEE802_11 (105) captures. */
  P.pcap = function (frames, linktype) {
    const total = 24 + frames.reduce((s, f) => s + 16 + f.bytes.length - 4, 0);
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint32(0, 0xa1b2c3d4, true);
    dv.setUint16(4, 2, true);
    dv.setUint16(6, 4, true);
    dv.setInt32(8, 0, true);
    dv.setUint32(12, 0, true);
    dv.setUint32(16, 65535, true);
    dv.setUint32(20, linktype, true);
    let o = 24;
    for (const f of frames) {
      const tUs = Math.round((Sim.EPOCH_MS + f.time) * 1000);
      const len = f.bytes.length - 4;
      dv.setUint32(o, Math.floor(tUs / 1e6), true);
      dv.setUint32(o + 4, tUs % 1e6, true);
      dv.setUint32(o + 8, len, true);
      dv.setUint32(o + 12, len, true);
      u8.set(f.bytes.subarray(0, len), o + 16);
      o += 16 + len;
    }
    return buf;
  };
})();
