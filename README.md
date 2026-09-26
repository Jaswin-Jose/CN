# IoT Packet Lab — IoT Network Simulator

Browser-based simulator of sensor → gateway → server communication with real packet formats.

## Run
Double-click `index.html` (or right-click → Open With → Chrome). No install or server needed.
`dist/iot-packet-lab.html` is the same app in one file (rebuild with `python3 build.py`).

The simulator runs the **Smart Home** network: 7 sensors, gateway GW-1, router ISP-R1, server CLOUD-1.
*Restore Smart Home* rebuilds the original layout.

## Tests and experiments (need Node.js)
- `node tests/run-tests.js`: 12 test cases (checksums, DHCP, NAT/TTL, repeatability, faults, queue overflow…)
- `node tests/run-experiments.js`: Normal / Busy / Stress / link drop / interference / gateway failure, 120 s each

## Using it
- **Add device**: pick a sensor or network device, choose Wi-Fi or Ethernet, press *Add to network*.
- **Wi-Fi** sensors join the strongest gateway in range. Signal (RSSI) depends on distance, so dragging a sensor changes its loss.
- **Draw cable** tool: drag from one device to another to lay an Ethernet cable.
- **Click a link** to open its packet capture: frame list, decoded headers, raw hex. *Download .pcap* opens in Wireshark.
- **Click a moving packet** to inspect that exact frame.
- **Packet Manager** tab: every packet with its status, a hop-by-hop trace, per-device and per-link tables, loss causes, run snapshots, and CSV/JSON/log exports.

## What a packet contains
Wi-Fi hop: IEEE 802.11 data frame + LLC/SNAP + IPv4 + UDP + CoAP (RFC 7252) + JSON reading + FCS.
Ethernet hop: Ethernet II + IPv4 + UDP + CoAP + JSON + FCS.
IPv4 and UDP checksums and the CRC-32 FCS are calculated for real. The gateway lowers TTL and applies NAT
(192.168.x.x → public WAN address), and MAC addresses change on every hop.

## Metrics
- Packet loss % = lost ÷ (received + lost) × 100
- Delivery rate % = received ÷ (received + lost) × 100
- Average delay = sum of end-to-end delays of received packets ÷ received
- Throughput = received packets ÷ simulated seconds

## Modules
| File | Module |
|---|---|
| main.js | System integration |
| core.js | Shared namespace, seeded random numbers, event queue, settings |
| engine.js | Simulation engine and packet lifecycle |
| topology.js | IoT topology & node modeling, MAC/IP, DHCP |
| connections.js | Network connection management, Wi-Fi radio model |
| sensors.js | Sensor data simulation |
| routing.js | Packet routing & forwarding, NAT |
| protocol.js | Packet encoding, checksums, pcap export |
| render.js | Packet movement visualization |
| ui.js | Simulation control interface, capture viewer, Packet Manager |
| metrics.js | Network metrics & performance analysis |
| scenarios.js | Smart Home scenario, fault & stress tests |
| logger.js | Event logging & report generation |
| tests/run-tests.js | Test cases |
| tests/run-experiments.js | Experiments |
