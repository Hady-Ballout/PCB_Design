# Remote Interphone Gate Opener

A WiFi replacement for the resident side of a Beirut apartment-building interphone.
A visitor scans a QR code at the gate, picks an apartment on a web page, the
resident gets a phone notification and taps Unlock; this board pulses a relay
whose dry contact is wired **in parallel with an existing handset's door-open
button**. No changes to the gate wiring, and the strike voltage (AC or DC) never
touches this board.

- `circuit.json` — the verified circuit (20 components, 14 real nets)
- `verify.mjs` — CLAUDE.md step-7 engine gates + step-8 pin-assignment assertions.
  Run from the repo root: `node projects/gate-opener/verify.mjs`

## Design

| Block | Parts | Notes |
|---|---|---|
| Power in | J1 usb_c, R1/R2 5.1k CC pull-downs, D1 TVS 6.8V, C1 10µF + C2 100nF | 5V wall adapter; CC pull-downs are mandatory for a USB-C source to enable VBUS |
| 3.3V rail | V2 regulator "3.3V" (AMS1117-class), C3 10µF + C4 100nF | Value written `"3.3V"` deliberately — the part-number form parses as 1117 V (known engine defect) |
| MCU | U1 ESP32-S3-WROOM-1-N8 | EN: R3 10k→3V3 + C5 1µF→0 + R7 RESET button; IO0: R4 10k→3V3 + R6 BOOT button; native USB on IO19/IO20 (both connector rows tied) — this is also the programming port |
| Gate output | U2 relay_module SRD-05, J2 terminal block | IO4 → relay IN (module has its own opto/driver); COM/NO dry contact → J2 |
| Status | R5 330Ω + D2 green LED on IO48 | ~3.9 mA at 3.3V (Vf≈2.0V) — safe GPIO load |

## Verification evidence (2026-08-12)

MCP tool chain (`validate_circuit → pcb_layout → render_schematic →
simulate_circuit → export_netlist`):

| Gate | Result |
|---|---|
| validate | ok, 0 errors, **0 warnings** |
| topology | ok, 0 violations |
| routing | complete, 0 failed nets |
| DRC | ok, 0 violations |
| connectivity | ok, 0 incomplete nets |
| board (MCP layout) | 106×65 mm, 2 layers, 148 traces, 19 vias, manufacturable |
| board (local engine) | 69×61 mm, 136 traces, 14 vias — same gates clean; server build places less tightly |
| schematic | full render, all 20 parts placed (no fallback) |
| simulation | VBUS 5.000 V, 3V3 3.300 V, EN/BOOT 3.297 V (10k pull-up vs 10 MΩ open-button model) |
| Gerber export | passed the hard manufacturability gate — 10-file RS-274X + Excellon package, 118 drills |

Step-8 assertions (the checks no gate performs — pin *assignment*, not count):
ESP32 41-pin table replayed against layout pads; IO4→RELAY_IN, IO19/IO20→USB D−/D+,
IO48→LED, IO0→BOOT, GND/GND/EPAD→0; strapping IO3/IO45/IO46 unloaded; relay
COM/NO (not NC) reach the terminal block; EN and BOOT RC/button chains present;
two distinct CC pull-downs; TVS reverse-biased; regulator value exactly `"3.3V"`.
All pass — see `verify.mjs`.

### Engine quirk found during this run

`simulate_circuit` failed on the first attempt: `chooseWaveformNodes`
(`server/simulation/simulator.ts:85`) picks the first four non-ground nets in
component order, and with the USB connector listed first it chose `USB_DP`/`USB_DM`
— nets that exist only on wiring-only parts, so ngspice has no such vectors and
`wrdata` aborts. Workaround (used here): the simulate call passes the same
circuit with sources/resistors listed first so the probes land on VBUS/3V3/EN/BOOT.
Candidate fix (not applied): filter probe candidates to nets touched by at least
one simulated (non-wiring-only) component.

## Before ordering boards

- **USB-C footprint is a synthesized placeholder header** — swap in a vendored
  receptacle footprint first (usb_c doc gotcha).
- **Relay module choice matters**: most cheap boards are active-low and can
  chatter while IO4 floats during boot. Pick an active-high (or
  jumper-configurable) module whose opto input accepts 3.3V logic; firmware must
  drive IO4 to the idle level first thing and keep the unlock pulse ≤1 s.
- Relay contacts (10 A / 250 VAC) far exceed the handset button's load; the
  contact is galvanically isolated so bus polarity doesn't matter. On site,
  identify the two wires across the handset's door-open button and land them on J2.
- The board has no USB-UART: first flash and all reflashing happen over native
  USB (BOOT held, tap RESET, release BOOT → bootloader).

## Software architecture (next phase — not built yet)

QR sticker encodes a static URL `https://<app>/b/<building-id>`. A static page
(Firebase Hosting, already used by this project) lists the building's apartments
from Firestore. Visitor taps an apartment → Cloud Function writes a "ring" doc →
resident's phone gets an FCM push via an installable PWA (no app-store friction).
Resident taps Unlock → Function checks Firebase Auth per-apartment claims →
publishes an unlock command. The board subscribes over MQTT/TLS (sub-second
latency, near-zero idle bandwidth, NAT-friendly — preferred over polling) to
`building/<id>/unlock`, verifies a short-lived HMAC token in the payload, pulses
IO4 for ~500 ms, then publishes an ack that flips the visitor page to "door open".

Abuse controls: rate-limit rings per apartment; unlock tokens expire in ≤30 s;
log every actuation; the visitor page can ring but never unlock; broker
credentials live only on the device and in Functions config.
