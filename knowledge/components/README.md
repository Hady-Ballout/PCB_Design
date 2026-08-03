# Components

Every component kind the circuit validator accepts. One file per kind.

**`kind` and `pin_order` are the two facts that must be right.** `kind` is the
exact string that goes in the JSON; `pin_order` is the order net names must
appear in that component's `nodes` array. Both are generated from
`src/core/componentKinds.js` and `src/core/topologyRules.js`, so they cannot
drift from what the code accepts.

Regenerate after changing either source file:

```bash
node scripts/build-component-docs.mjs
```

- **Written ✅** — the prose has been filled in and reviewed.
- **Written —** — frontmatter is correct, but the prose is still a stub. The
  pin order is still trustworthy; the wiring advice is not there yet.

To add a component that does not exist yet, see
[../prompts/add-a-component.md](../prompts/add-a-component.md).

| Kind | Label | Category | Pin order | Written |
|------|-------|----------|-----------|---------|
| [`adc_module`](adc_module.md) | ADC (MCP3008) | Drivers & interface ICs | `CH0, CH1, CH2, CH3, CH4, CH5, CH6, CH7, DGND, CS, DIN, DOUT, CLK, AGND, VREF, VDD` | — |
| [`arduino_uno`](arduino_uno.md) | Arduino Uno | Boards | `5V, 3V3, GND, VIN, D0, D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, A0, A1, A2, A3, A4, A5` | — |
| [`baro_sensor`](baro_sensor.md) | Barometric sensor (BMP280, I2C) | Sensors | `VCC, GND, SCL, SDA` | — |
| [`bjt_npn`](bjt_npn.md) | NPN transistor | Transistors | `collector, base, emitter` | — |
| [`bjt_pnp`](bjt_pnp.md) | PNP transistor | Transistors | `collector, base, emitter` | — |
| [`bridge_rectifier`](bridge_rectifier.md) | Bridge rectifier | Diodes & LEDs | `AC1, AC2, V+, V-` | — |
| [`buck_converter`](buck_converter.md) | Buck converter (LM2596) | Power | `VIN, OUT, GND, FB, ON_OFF` | — |
| [`buzzer`](buzzer.md) | Buzzer | Actuators & motors | 2 pins, no contract | — |
| [`capacitor`](capacitor.md) | Capacitor | Passives | 2 pins, no contract | ✅ |
| [`comparator`](comparator.md) | Comparator | Analog ICs | `IN+, IN-, OUT, V+, V-` | — |
| [`crystal`](crystal.md) | Crystal | Passives | 2 pins, no contract | — |
| [`current_sensor`](current_sensor.md) | Current sensor (ACS712) | Sensors | `IP+, IP-, VCC, OUT, GND` | — |
| [`dc_motor`](dc_motor.md) | DC motor | Actuators & motors | 2 pins, no contract | — |
| [`dht_sensor`](dht_sensor.md) | DHT temperature/humidity sensor | Sensors | `VCC, DATA, GND` | — |
| [`diode`](diode.md) | Diode | Diodes & LEDs | `anode, cathode` | — |
| [`esp32`](esp32.md) | ESP32 | Boards | `3V3, GND, VIN, EN, GPIO2, GPIO4, GPIO5, GPIO13, GPIO18, GPIO19, GPIO21, GPIO22` | — |
| [`fuse`](fuse.md) | Fuse | Passives | 2 pins, no contract | — |
| [`gas_sensor`](gas_sensor.md) | Gas sensor (MQ-2) | Sensors | `VCC, GND, DO, AO` | — |
| [`hall_sensor`](hall_sensor.md) | Hall sensor (A3144) | Sensors | `VCC, GND, OUT` | — |
| [`imu_sensor`](imu_sensor.md) | IMU (MPU6050, I2C) | Sensors | `VCC, GND, SCL, SDA` | — |
| [`inductor`](inductor.md) | Inductor | Passives | 2 pins, no contract | — |
| [`ir_led`](ir_led.md) | IR emitter LED | Diodes & LEDs | `anode, cathode` | — |
| [`ir_phototransistor`](ir_phototransistor.md) | IR phototransistor (raw receiver) | Sensors | 2 pins, no contract | — |
| [`ir_receiver`](ir_receiver.md) | IR receiver (TSOP38xx) | Sensors | `OUT, GND, VCC` | — |
| [`joystick`](joystick.md) | Joystick (KY-023) | Input devices | `GND, VCC, VRX, VRY, SW` | — |
| [`keypad`](keypad.md) | Keypad (4x4 membrane) | Input devices | `R1, R2, R3, R4, C1, C2, C3, C4` | — |
| [`lcd_display`](lcd_display.md) | LCD 16x2 (I2C) | Displays | `GND, VCC, SDA, SCL` | — |
| [`led`](led.md) | LED | Diodes & LEDs | `anode, cathode` | ✅ |
| [`led_strip`](led_strip.md) | LED strip (WS2812 NeoPixel) | Displays | `VCC, DIN, GND` | — |
| [`load`](load.md) | Load | Passives | 2 pins, no contract | — |
| [`mosfet_n`](mosfet_n.md) | N-channel MOSFET | Transistors | `drain, gate, source` | — |
| [`mosfet_p`](mosfet_p.md) | P-channel MOSFET | Transistors | `drain, gate, source` | — |
| [`motor_driver`](motor_driver.md) | Motor driver (L298N) | Drivers & interface ICs | `VS, GND, ENA, IN1, IN2, ENB, IN3, IN4, OUT1, OUT2, OUT3, OUT4` | — |
| [`mouse_sensor`](mouse_sensor.md) | Mouse sensor (PMW3360, SPI) | Sensors | `RST, GND, MOT, NCS, SCK, MOSI, MISO, VCC` | — |
| [`oled_display`](oled_display.md) | OLED display (I2C) | Displays | `VCC, GND, SCL, SDA` | — |
| [`opamp`](opamp.md) | Op amp | Analog ICs | `IN+, IN-, OUT, V+, V-` | — |
| [`optocoupler`](optocoupler.md) | Optocoupler (PC817) | Drivers & interface ICs | `A, K, E, C` | — |
| [`photoresistor`](photoresistor.md) | Photoresistor (LDR) | Sensors | 2 pins, no contract | — |
| [`pir_sensor`](pir_sensor.md) | PIR motion sensor | Sensors | `VCC, OUT, GND` | — |
| [`potentiometer`](potentiometer.md) | Potentiometer | Passives | `end A, wiper, end B` | — |
| [`pushbutton`](pushbutton.md) | Pushbutton | Switches | `terminal 1, terminal 2` | — |
| [`raspberry_pi`](raspberry_pi.md) | Raspberry Pi | Boards | `5V, 3V3, GND, GPIO2, GPIO3, GPIO4, GPIO17, GPIO18, GPIO27, GPIO22, GPIO8, GPIO9, GPIO10, GPIO11` | — |
| [`regulator`](regulator.md) | Voltage regulator | Power | `IN, GND, OUT` | — |
| [`relay_module`](relay_module.md) | Relay module | Drivers & interface ICs | `VCC, GND, IN, COM, NO, NC` | — |
| [`resistor`](resistor.md) | Resistor | Passives | 2 pins, no contract | ✅ |
| [`rfid_reader`](rfid_reader.md) | RFID reader (RC522) | Modules | `3V3, RST, GND, IRQ, MISO, MOSI, SCK, SDA` | — |
| [`rgb_led`](rgb_led.md) | RGB LED | Diodes & LEDs | `red, green, blue, common` | — |
| [`rotary_encoder`](rotary_encoder.md) | Rotary encoder (KY-040) | Input devices | `CLK, DT, SW, VCC, GND` | — |
| [`rtc_module`](rtc_module.md) | RTC (DS3231, I2C) | Modules | `GND, VCC, SDA, SCL` | — |
| [`schottky`](schottky.md) | Schottky diode | Diodes & LEDs | `anode, cathode` | — |
| [`sd_card`](sd_card.md) | SD card module (SPI) | Modules | `VCC, GND, MISO, MOSI, SCK, CS` | — |
| [`servo`](servo.md) | Servo motor | Actuators & motors | `VCC, GND, SIG` | — |
| [`seven_segment`](seven_segment.md) | 7-segment display | Displays | `A, B, C, D, E, F, G, DP, COM` | — |
| [`shift_register`](shift_register.md) | Shift register (74HC595) | Drivers & interface ICs | `QB, QC, QD, QE, QF, QG, QH, GND, QH2, SRCLR, SRCLK, RCLK, OE, SER, QA, VCC` | — |
| [`signal_source`](signal_source.md) | Signal source | Sources | 2 pins, no contract | — |
| [`soil_moisture`](soil_moisture.md) | Soil moisture sensor (capacitive) | Sensors | `VCC, GND, AOUT` | — |
| [`solar_panel`](solar_panel.md) | Solar panel | Sources | `+, −` | — |
| [`sound_sensor`](sound_sensor.md) | Sound sensor (KY-038) | Sensors | `VCC, GND, DO, AO` | — |
| [`stepper_driver`](stepper_driver.md) | Stepper driver (ULN2003) | Drivers & interface ICs | `IN1, IN2, IN3, IN4, VCC, GND, OUTA, OUTB, OUTC, OUTD` | — |
| [`stepper_motor`](stepper_motor.md) | Stepper motor (28BYJ-48) | Actuators & motors | `A, B, C, D, COM` | — |
| [`switch_spdt`](switch_spdt.md) | SPDT switch | Switches | `common, throw A, throw B` | — |
| [`temp_sensor`](temp_sensor.md) | Temperature sensor | Sensors | `VCC, OUT, GND` | — |
| [`thermistor`](thermistor.md) | Thermistor | Sensors | 2 pins, no contract | — |
| [`timer_555`](timer_555.md) | 555 timer | Analog ICs | `GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC` | ✅ |
| [`ua741`](ua741.md) | Op amp (uA741) | Analog ICs | `OFS1, IN-, IN+, V-, OFS2, OUT, V+, NC` | — |
| [`ultrasonic_sensor`](ultrasonic_sensor.md) | Ultrasonic sensor (HC-SR04) | Sensors | `VCC, TRIG, ECHO, GND` | — |
| [`vibration_motor`](vibration_motor.md) | Vibration motor | Actuators & motors | `+, −` | — |
| [`voltage_source`](voltage_source.md) | Voltage source | Sources | 2 pins, no contract | ✅ |
| [`zener`](zener.md) | Zener diode | Diodes & LEDs | `anode, cathode` | — |

69 kinds.
