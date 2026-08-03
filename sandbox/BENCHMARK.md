# Benchmark

10 circuits built end to end through the sandbox — a prompt in, a verified
board out — with no human in the loop. Every row below is a real agent run: it read
the knowledge base, searched component values, wrote `circuit.json`, ran `verify.mjs`
against the engine, and iterated until the gates passed or it gave up.

**Model** `deepseek-v4-pro[1m]` · **10/10 passed** · $0.2417 total · 1265s of model time

Regenerate with `node sandbox/eval.mjs --parallel 3 --keep && node sandbox/benchmark.mjs > sandbox/BENCHMARK.md`.

## Results

| Case | Result | Board | Parts | Req | Fresh in | Cached | Out | Time | Cost |
|---|---|---|---|---|---|---|---|---|---|
| blink-1hz | **PASS** | 39x41mm | 9 | 7 | 46.2k | 250.8k | 4.6k | 78s | $0.0247 |
| buck-supply | **PASS** | 38x44mm | 8 | 8 | 36.2k | 261.4k | 7.4k | 141s | $0.0229 |
| button-mcu | **PASS** | 53x69mm | 10 | 11 | 46.1k | 462.1k | 11.2k | 212s | $0.0313 |
| dual-blinker | **PASS** | 53x62mm | 16 | 8 | 37.8k | 251.0k | 6.2k | 104s | $0.0225 |
| i2c-sensor | **PASS** | 55x54mm | 7 | 9 | 35.6k | 272.3k | 5.3k | 93s | $0.0209 |
| led-bar | **PASS** | 65x46mm | 18 | 8 | 37.9k | 254.8k | 5.9k | 113s | $0.0223 |
| motor-driver | **PASS** | 31x46mm | 7 | 8 | 40.3k | 262.9k | 5.5k | 107s | $0.0230 |
| opamp-preamp | **PASS** | 39x50mm | 10 | 9 | 37.7k | 301.6k | 8.9k | 160s | $0.0250 |
| rc-filter | **PASS** | 31x33mm | 5 | 9 | 35.9k | 289.3k | 5.8k | 112s | $0.0214 |
| temp-logger | **PASS** | 53x65mm | 12 | 9 | 44.3k | 338.8k | 8.7k | 145s | $0.0278 |

## Cost

Mean over the 10 passing boards: **$0.0242 per board**, 9 API requests, $0.00267 per component.

Across all 10 runs: 398.0k fresh input · 2.94M cache read · 69.4k output. 88% of prompt tokens were cache hits, which is why the bill tracks fresh input rather than total tokens.

Priced from stored token counts via `sandbox/pricing.json`. The Agent SDK's own
`total_cost_usd` reports roughly 20x these figures on this endpoint, because it prices
from its internal rate table rather than the provider's — see `README.md`.

### Cost against board size

| Case | Parts | Area | Requests | Cost |
|---|---|---|---|---|
| rc-filter | 5 | 10.2 cm² | 9 | $0.0214 |
| i2c-sensor | 7 | 29.7 cm² | 9 | $0.0209 |
| motor-driver | 7 | 14.3 cm² | 8 | $0.0230 |
| buck-supply | 8 | 16.7 cm² | 8 | $0.0229 |
| blink-1hz | 9 | 16.0 cm² | 7 | $0.0247 |
| button-mcu | 10 | 36.6 cm² | 11 | $0.0313 |
| opamp-preamp | 10 | 19.5 cm² | 9 | $0.0250 |
| temp-logger | 12 | 34.5 cm² | 9 | $0.0278 |
| dual-blinker | 16 | 32.9 cm² | 8 | $0.0225 |
| led-bar | 18 | 29.9 cm² | 8 | $0.0223 |

Largest board is 3.6x the part count of the smallest but 1.0x the cost. Component count drives design turns, not prompt size, and turns are mostly cache reads — so per-board cost is far flatter than part count suggests.

## How to read this

A PASS means the board cleared all five engine gates — validation with zero warnings,
28 topology rules, complete routing, clean DRC, complete connectivity — **and** the
case's assertions about what it structurally had to be. That second half is the one
that matters: a 555 blinker wired as a one-shot passes all five gates on a board that
cannot blink, so the gates alone do not distinguish a working circuit from a
manufacturable one.

It does **not** mean the board was simulated, or that its values are right. Nothing
here checks the arithmetic. Where a case has a design equation, the numbers were
spot-checked by hand against the produced JSON — the op-amp came out at a gain of
exactly 10.000 from 27k/3k, and the buck converter put the inductor and the catch
diode cathode on the switch node with FB taken from the output rail, which is the
contract most often got wrong from recall.

**The assertions are the weak link, not the model.** Three cases failed during
authoring because the assertion was wrong, not the circuit: one demanded two resistors
from a design that correctly needed one, one used arithmetic the expression language
did not support, and one named pins the parser could not read. Each was a real defect
in this harness, fixed and covered by a test. Treat a new failure as a claim to check
before it is a verdict.

## What each case is for

**blink-1hz** — Build a circuit that blinks an LED once per second, running from a 9 V battery.

> The baseline. A 555 astable is the expected topology; local/blinker-1hz.json is a known-good answer at 0.99 Hz.

**buck-supply** — Build a 12 V to 5 V switching supply using a buck converter, with a barrel jack input and screw terminals on the 5 V output.

> The hardest pin contract in the library. buck_converter is [VIN, OUT, GND, FB, ON_OFF] where nodes[1] is the SWITCH node, not the rail — the inductor goes there and the catch diode's cathode with it. Four rules police it: buck_missing_inductor, buck_missing_catch_diode, buck_fb_misrouted, buck_insufficient_headroom. Getting this from recall rather than from the component page reliably fails.

**button-mcu** — Build a 3.3 V ESP32 board with a pushbutton on a GPIO input and an LED on a different GPIO, powered from a barrel jack.

> Tests CLAUDE.md step 5 — rules that fire on combinations rather than on one part. `pushbutton_no_pull` only fires when the button sits on a net the graph knows is a GPIO, so the button must actually reach the MCU; a button switching an LED directly is a legitimate design that never triggers it. `led_no_series_resistor` applies regardless. An earlier version of this case asked for a plain 5 V button-and-LED board and asserted two resistors; the agent correctly built button → resistor → LED in series and the case was wrong, not the board.

**dual-blinker** — Build a board with two LEDs on one 9 V supply: one blinking every 2 seconds, the other every 2.5 seconds.

> Two independent 555 astables sharing a rail. Tests whether the agent suffixes nets per stage instead of letting the two blocks short together — the failure mode is CT1/CT2 both being called CT.

**i2c-sensor** — Build a 3.3 V ESP32 board that reads a BMP280 barometric sensor over I2C and shows readings on an I2C OLED display.

> Two devices on one bus. i2c_missing_pullups wants SDA and SCL pulled to the logic supply, and both modules share the pair — the failure mode is giving each device its own bus nets so nothing is actually shared.

**led-bar** — Build a 5 V indicator bar: six LEDs in a row, each with its own series resistor, all driven from a pin header so an external board can switch them. Power comes in on screw terminals.

> Repetition and fan-out. Six independent legs plus a wide pin header exercise the router more than the design; `led_no_series_resistor` fires per LED if the agent economises.

**motor-driver** — Build a 12 V board where a microcontroller GPIO switches a DC motor on and off through an N-channel MOSFET. The control signal arrives on a pin header.

> Tests combination rules from CLAUDE.md step 5: missing_flyback_diode across the motor and mosfet_gate_no_pulldown on a gate that would otherwise float while the MCU is in reset.

**opamp-preamp** — Build a non-inverting op-amp amplifier with a gain of 10, running from a 9 V supply, input and output on screw terminals.

> Analog with a gain equation: 1 + Rf/Rg = 10, so the ratio must be 9:1 from E24 values. opamp_input_floating fires if either input is left unreferenced, and missing_supply_decoupling applies to the analog rail.

**rc-filter** — Build a passive RC low-pass filter with a 1 kHz cutoff, fed from a 5 V supply, with screw terminals for the input and the output.

> Small and unambiguous, but it exercises the connector kinds and forces the agent to size R and C against an equation rather than recall a stock value.

**temp-logger** — Build a battery-powered temperature logger: an ESP32 reading an analog temperature sensor, with a real-time clock module, a status LED, and a regulated 3.3 V rail from a 9 V battery.

> The largest case — four subsystems on one board. Tests whether the agent reads regulator.md (writing value as "3.3V" rather than a part number, which the known parser defect turns into 1117 V and a false pullup_exceeds_domain) and rtc_module.md, whose pin order [GND, VCC, SDA, SCL] is reversed from every other I2C module in the library.

