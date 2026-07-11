// Arduino Uno (ATmega328P) firmware execution for the live breadboard
// simulation, built on avr8js. The runner owns the CPU, timers, GPIO ports,
// USART, and ADC; the engine's bridge steps it in lockstep with the MNA
// timestep and shuttles pin states/net voltages both ways.
import {
  AVRADC,
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from 'avr8js';

export const AVR_CLOCK_HZ = 16e6;
const FLASH_WORDS = 0x8000; // 32 KB ATmega328P flash

// Intel HEX loader (record type 00 data only — sufficient for the Uno's
// <64 KB address space; extended-address records never appear in its .hex).
export const loadHex = (source, target) => {
  for (const line of String(source || '').split('\n')) {
    if (line[0] === ':' && line.substr(7, 2) === '00') {
      const bytes = parseInt(line.substr(1, 2), 16);
      const addr = parseInt(line.substr(3, 4), 16);
      for (let i = 0; i < bytes; i += 1) {
        target[addr + i] = parseInt(line.substr(9 + i * 2, 2), 16);
      }
    }
  }
};

// Uno pin name → { port letter, bit }. A0-A5 double as ADC channels 0-5.
export const UNO_PIN_MAP = Object.fromEntries([
  ...Array.from({ length: 8 }, (_, i) => [`D${i}`, { port: 'D', bit: i }]),
  ...Array.from({ length: 6 }, (_, i) => [`D${i + 8}`, { port: 'B', bit: i }]),
  ...Array.from({ length: 6 }, (_, i) => [`A${i}`, { port: 'C', bit: i, adcChannel: i }]),
]);

// Hand-assembled AVR test programs (no toolchain needed in CI):
// D13 = PB5. SBI 0x9A25 sets DDRB.5, 0x9A2D sets PORTB.5, CBI 0x982D clears
// it, RJMP words loop.
export const TEST_PROGRAM_D13_HIGH = Uint16Array.from([0x9a25, 0x9a2d, 0xcfff]);
// Tightest possible toggle (4-cycle loop) — useful for runner-level tests
// only; it phase-locks against fixed sampling strides.
export const TEST_PROGRAM_D13_TOGGLE = Uint16Array.from([0x9a25, 0x9a2d, 0x982d, 0xcffd]);
// Realistic blinker: each phase holds ~600 cycles via a DEC/BRNE delay loop
// (LDI r24,200 = 0xEC88; DEC r24 = 0x958A; BRNE .-2 = 0xF7F1), so the
// engine's ~320-cycle timestep samples both phases like real firmware.
export const TEST_PROGRAM_D13_BLINK = Uint16Array.from([
  0x9a25, // SBI DDRB,5
  0x9a2d, // loop: SBI PORTB,5
  0xec88, 0x958a, 0xf7f1, // delay ~600 cycles
  0x982d, // CBI PORTB,5
  0xec88, 0x958a, 0xf7f1, // delay ~600 cycles
  0xcff7, // RJMP loop
]);

// LDI Rd,K encodes K's nibbles around the register: 1110 KKKK dddd KKKK.
const ldi = (reg, value) => 0xe000 | ((value & 0xf0) << 4) | ((reg - 16) << 4) | (value & 0x0f);

// Servo PWM on D9 (PB1): a pulse of `pulseIterations`·4 cycles (SBIW+BRNE)
// every ~20 ms (LDI r26,5 outer loop holds the ~18.5 ms low phase).
const buildServoProgram = (pulseIterations) => Uint16Array.from([
  0x9a21, // SBI DDRB,1
  0x9a29, // loop: SBI PORTB,1
  ldi(24, pulseIterations & 0xff), ldi(25, (pulseIterations >> 8) & 0xff),
  0x9701, 0xf7f1, // SBIW r24,1; BRNE .-2
  0x9829, // CBI PORTB,1
  ldi(26, 5), // outer counter
  ldi(24, 14800 & 0xff), ldi(25, 14800 >> 8), // 59 200-cycle inner block
  0x9701, 0xf7f1,
  0x95aa, // DEC r26
  0xf7d1, // BRNE outer (back to the LDI pair)
  0xcff2, // RJMP loop
]);

// 1500 µs (24 000 cycles → 6000 SBIW iterations) and 1750 µs (7000).
export const TEST_PROGRAM_SERVO_1500 = buildServoProgram(6000);
export const TEST_PROGRAM_SERVO_1750 = buildServoProgram(7000);

// Single ~12 µs TRIG pulse on D7 (PD7), then spin.
export const TEST_PROGRAM_TRIG_PULSE = Uint16Array.from([
  0x9a57, // SBI DDRD,7
  0x9a5f, // SBI PORTD,7
  0xe480, 0x958a, 0xf7f1, // ~192-cycle delay (12 µs)
  0x985f, // CBI PORTD,7
  0xcfff, // spin
]);

// DHT start condition on D2 (PD2): drive low ~1.2 ms, release to input, spin.
export const TEST_PROGRAM_DHT_START = Uint16Array.from([
  0x9a52, // SBI DDRD,2 (output)
  0x985a, // CBI PORTD,2 (low)
  0xec80, 0xe192, 0x9701, 0xf7f1, // 4800 SBIW iterations ≈ 19 200 cycles ≈ 1.2 ms
  0x9852, // CBI DDRD,2 (release to input)
  0xcfff, // spin
]);

export const createAvrRunner = ({ hex, program }) => {
  const flash = new Uint16Array(FLASH_WORDS);
  if (program) flash.set(program);
  else loadHex(hex, new Uint8Array(flash.buffer));

  const cpu = new CPU(flash);
  // Peripherals register clock events on the CPU; cpu.tick() drains them —
  // never call a timer's tick manually with modern avr8js.
  const timers = [
    new AVRTimer(cpu, timer0Config),
    new AVRTimer(cpu, timer1Config),
    new AVRTimer(cpu, timer2Config),
  ];
  const ports = {
    B: new AVRIOPort(cpu, portBConfig),
    C: new AVRIOPort(cpu, portCConfig),
    D: new AVRIOPort(cpu, portDConfig),
  };
  const usart = new AVRUSART(cpu, usart0Config, AVR_CLOCK_HZ);
  const adc = new AVRADC(cpu, adcConfig);

  let serialListener = null;
  usart.onByteTransmit = (value) => {
    serialListener?.(value);
  };

  return {
    cpu,
    timers,
    ports,
    adc,
    run(cycles) {
      const target = cpu.cycles + cycles;
      while (cpu.cycles < target) {
        avrInstruction(cpu);
        cpu.tick();
      }
    },
    // → {mode: 'output'|'input'|'pullup', high} for a named Uno pin.
    pinState(unoPin) {
      const map = UNO_PIN_MAP[unoPin];
      const state = ports[map.port].pinState(map.bit);
      if (state === PinState.High) return { mode: 'output', high: true };
      if (state === PinState.Low) return { mode: 'output', high: false };
      return { mode: state === PinState.InputPullUp ? 'pullup' : 'input', high: false };
    },
    setDigitalInput(unoPin, high) {
      const map = UNO_PIN_MAP[unoPin];
      ports[map.port].setPin(map.bit, high);
    },
    setAnalogVolts(channel, volts) {
      adc.channelValues[channel] = volts;
    },
    onSerialByte(listener) {
      serialListener = listener;
    },
  };
};
