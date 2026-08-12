// Verification for the gate-opener circuit, per CLAUDE.md steps 7 and 8.
// Run from the repo root:  node projects/gate-opener/verify.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateCircuit } from '../../src/core/pcbGenerator.js';
import { checkCircuitTopology } from '../../src/core/topologyRules.js';
import { buildPcbLayout } from '../../src/core/pcbLayout.js';

const here = dirname(fileURLToPath(import.meta.url));
const circuit = JSON.parse(readFileSync(join(here, 'circuit.json'), 'utf8'));

const byRef = (ref) => circuit.components.find((c) => c.ref === ref);

// ---- Step 7: the five engine verdicts -------------------------------------
const validation = validateCircuit(circuit);
assert.equal(validation.ok, true, JSON.stringify(validation.errors));
assert.equal(validation.errors.length, 0);
assert.equal(validation.warnings.length, 0, JSON.stringify(validation.warnings));

const topology = checkCircuitTopology(circuit);
assert.equal(topology.ok, true, JSON.stringify(topology.violations));
assert.equal(topology.violations.length, 0);

const layout = buildPcbLayout(circuit);
assert.equal(layout.routing.complete, true, JSON.stringify(layout.routing.failedNets));
assert.equal(layout.drc.ok, true, JSON.stringify(layout.drc.violations));
assert.equal(layout.connectivity.ok, true, JSON.stringify(layout.connectivity.incompleteNets));

// ---- Step 8: pin-assignment invariants the gates cannot see ---------------
const U1 = byRef('U1'); // esp32_s3_wroom
const U2 = byRef('U2'); // relay_module
const J1 = byRef('J1'); // usb_c
const J2 = byRef('J2'); // terminal_block
const V2 = byRef('V2'); // regulator
const D1 = byRef('D1'); // tvs

// ESP32 pin table replay against the layout's actual pads.
const ESP32_PINS = ['GND','3V3','EN','IO4','IO5','IO6','IO7','IO15','IO16','IO17','IO18','IO8','IO19','IO20','IO3','IO46','IO9','IO10','IO11','IO12','IO13','IO14','IO21','IO47','IO48','IO45','IO0','IO35','IO36','IO37','IO38','IO39','IO40','IO41','IO42','RXD0','TXD0','IO2','IO1','GND','EPAD'];
const pads = layout.components.find((c) => c.ref === 'U1').pads;
assert.equal(U1.nodes.length, 41);
assert.equal(pads.length, 41);
pads.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)} ${ESP32_PINS[i].padEnd(5)} -> ${p.net}`));
assert.equal(pads[3].net, 'RELAY_IN');   // IO4 drives the relay
assert.equal(pads[12].net, 'USB_DM');    // IO19 = USB D-
assert.equal(pads[13].net, 'USB_DP');    // IO20 = USB D+
assert.equal(pads[24].net, 'LED_STAT');  // IO48 status LED
assert.equal(pads[26].net, 'BOOT');      // IO0 boot strapping
for (const i of [0, 39, 40]) assert.equal(pads[i].net, '0'); // GND, GND, EPAD
for (const i of [14, 15, 25]) assert.match(U1.nodes[i], /^NC_U1_/); // strapping IO3/IO46/IO45 unloaded

// Relay: coil on 5V, IN from IO4, COM/NO (not NC) out to the terminal block.
assert.equal(U2.nodes[0], 'VBUS');
assert.equal(U2.nodes[1], '0');
assert.equal(U2.nodes[2], U1.nodes[3]);
assert.equal(U2.nodes[3], J2.nodes[0]); // COM
assert.equal(U2.nodes[4], J2.nodes[1]); // NO
assert.match(U2.nodes[5], /^NC_U2_/);   // NC unused

// EN chain: 10k to 3V3, 1uF to ground, RESET button to ground.
const partsOn = (net, kind) => circuit.components.filter((c) => c.kind === kind && c.nodes.includes(net));
assert.ok(partsOn('EN', 'resistor').some((r) => r.value === '10k' && r.nodes.includes('3V3')));
assert.ok(partsOn('EN', 'capacitor').some((c) => c.value === '1uF' && c.nodes.includes('0')));
assert.ok(partsOn('EN', 'pushbutton').some((b) => b.nodes.includes('0')));

// BOOT chain: 10k to 3V3, BOOT button to ground.
assert.ok(partsOn('BOOT', 'resistor').some((r) => r.value === '10k' && r.nodes.includes('3V3')));
assert.ok(partsOn('BOOT', 'pushbutton').some((b) => b.nodes.includes('0')));

// USB data: both connector rows tied and landing on the right MCU pins.
assert.equal(J1.nodes[3], J1.nodes[12]); // DP_A6 = DP_B6
assert.equal(J1.nodes[3], U1.nodes[13]); // -> IO20 (D+)
assert.equal(J1.nodes[4], J1.nodes[11]); // DM_A7 = DM_B7
assert.equal(J1.nodes[4], U1.nodes[12]); // -> IO19 (D-)

// CC pull-downs: two distinct 5.1k resistors, one per CC pin.
const cc1 = partsOn('CC1', 'resistor').filter((r) => r.value === '5.1k' && r.nodes.includes('0'));
const cc2 = partsOn('CC2', 'resistor').filter((r) => r.value === '5.1k' && r.nodes.includes('0'));
assert.equal(cc1.length, 1);
assert.equal(cc2.length, 1);
assert.notEqual(cc1[0].ref, cc2[0].ref);
assert.equal(J1.nodes[2], 'CC1');
assert.equal(J1.nodes[13], 'CC2');

// TVS reverse-biased across VBUS; regulator value written the non-defective way.
assert.deepEqual(D1.nodes, ['0', 'VBUS']);
assert.equal(V2.value, '3.3V');
assert.deepEqual(V2.nodes, ['VBUS', '0', '3V3']);
assert.equal(circuit.supplyVoltage, 5);

console.log('validate     ok=%s errors=%d warnings=%d', validation.ok, validation.errors.length, validation.warnings.length);
console.log('topology     ok=%s violations=%d', topology.ok, topology.violations.length);
console.log('routing      complete=%s failed=%d', layout.routing.complete, layout.routing.failedNets.length);
console.log('drc          ok=%s violations=%d', layout.drc.ok, layout.drc.violations.length);
console.log('connectivity ok=%s incomplete=%d', layout.connectivity.ok, layout.connectivity.incompleteNets.length);
console.log('board        %dx%dmm traces=%d vias=%d', layout.board.width, layout.board.height, layout.traces.length, layout.vias.length);
console.log('ALL CHECKS PASSED');
