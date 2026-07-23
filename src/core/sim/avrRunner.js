// Arduino Uno (ATmega328P) firmware execution for the live breadboard
// simulation, built on avr8js. The runner owns the CPU, timers, GPIO ports,
// USART, and ADC; the engine's bridge steps it in lockstep with the MNA
// timestep and shuttles pin states/net voltages both ways.
import {
  AVRADC,
  AVRIOPort,
  AVRSPI,
  AVRTWI,
  AVRTimer,
  AVRUSART,
  CPU,
  PinState,
  adcConfig,
  avrInstruction,
  portBConfig,
  portCConfig,
  portDConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
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

// SPI master fixture: CS=D10/PB2, transfers the given bytes over hardware
// SPI (SPE|MSTR, fosc/128), storing each response at SRAM 0x0100+i.
// Opcodes: OUT SPCR(0x2C) = 0xBD8C for r24; IN r25,SPSR(0x2D) = 0xB59D;
// SBRS r25,7 = 0xFF97; IN r24,SPDR(0x2E) = 0xB58E; STS = 0x9380 + address.
export const buildSpiProgram = (bytes, { selectCs = true } = {}) => {
  const words = [
    0x9a22, // SBI DDRB,2 (CS)
    0x9a23, // SBI DDRB,3 (MOSI)
    0x9a25, // SBI DDRB,5 (SCK)
    0x9a2a, // SBI PORTB,2 (CS idle high)
    0xe583, // LDI r24, 0x53 (SPE|MSTR|fosc/128)
    0xbd8c, // OUT SPCR, r24
  ];
  if (selectCs) words.push(0x982a); // CBI PORTB,2 (select)
  bytes.forEach((byte, index) => {
    words.push(
      0xe000 | ((byte & 0xf0) << 4) | 0x80 | (byte & 0x0f), // LDI r24, byte
      0xbd8e, // OUT SPDR, r24
      0xb59d, // poll: IN r25, SPSR
      0xff97, // SBRS r25, 7 (skip next when SPIF set)
      0xcffd, // RJMP .-3 (back to the IN)
      0xb58e, // IN r24, SPDR
      0x9380, 0x0100 + index, // STS 0x0100+i, r24
    );
  });
  if (selectCs) words.push(0x9a2a); // SBI PORTB,2 (deselect)
  words.push(0xcfff); // spin
  return Uint16Array.from(words);
};

// WS2812 frame on DIN=D6/PD6, bit-banged like the NeoPixel library: a short
// (~2-cycle) high is a 0 bit, a long (~14-cycle, via a NOP sled) high is a 1.
// Bytes are GRB order, MSB-first; the trailing spin provides the latch gap.
export const buildWs2812Program = (grbBytes) => {
  const words = [0x9a56]; // SBI DDRD,6
  for (const byte of grbBytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      words.push(0x9a5e); // SBI PORTD,6 (rising edge)
      if ((byte >> bit) & 1) {
        for (let i = 0; i < 12; i += 1) words.push(0x0000); // NOP sled → ~14-cycle high
      }
      words.push(0x985e); // CBI PORTD,6 (falling edge)
      words.push(0x0000, 0x0000); // inter-bit low
    }
  }
  words.push(0xcfff); // spin (the idle gap latches the frame)
  return Uint16Array.from(words);
};

// Stepper coil sequence on D2-D5 (PD2-PD5): each mask drives IN1-IN4 (bit 0
// → D2 … bit 3 → D5), holds ~holdIterations·4 cycles, then advances; the
// whole sequence loops forever.
export const buildStepperProgram = (masks, holdIterations = 12000) => {
  const words = [0x9a52, 0x9a53, 0x9a54, 0x9a55]; // SBI DDRD,2..5
  const loopStart = words.length;
  for (const mask of masks) {
    for (let bit = 0; bit < 4; bit += 1) {
      words.push(((mask >> bit) & 1 ? 0x9a58 : 0x9858) | (bit + 2)); // SBI/CBI PORTD,bit+2
    }
    words.push(ldi(24, holdIterations & 0xff), ldi(25, (holdIterations >> 8) & 0xff));
    words.push(0x9701, 0xf7f1); // SBIW r24,1; BRNE .-2
  }
  words.push(0xc000 | ((loopStart - words.length - 1) & 0x0fff)); // RJMP loopStart
  return Uint16Array.from(words);
};

// Enable UART reception (UCSR0B = RXEN0) then spin — lets tests inject
// serial bytes and observe the RXC flag in UCSR0A.
export const TEST_PROGRAM_RX_ENABLE = Uint16Array.from([
  0xe180, // LDI r24, 0x10 (RXEN0)
  0x9380, 0x00c1, // STS UCSR0B, r24
  0xcfff, // spin
]);

// shiftOut(SER=D2/PD2, SRCLK=D3/PD3, MSBFIRST, byte) + RCLK(D4/PD4) latch
// pulse, unrolled: per bit, set/clear SER then pulse SRCLK.
export const buildShiftOutProgram = (byte) => {
  const words = [0x9a52, 0x9a53, 0x9a54]; // SBI DDRD,2/3/4
  for (let bit = 7; bit >= 0; bit -= 1) {
    words.push((byte >> bit) & 1 ? 0x9a5a : 0x985a); // SER = bit (PORTD,2)
    words.push(0x9a5b, 0x985b); // SRCLK pulse (PORTD,3)
  }
  words.push(0x9a5c, 0x985c); // RCLK latch pulse (PORTD,4)
  words.push(0xcfff); // spin
  return Uint16Array.from(words);
};

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
  const twi = new AVRTWI(cpu, twiConfig, AVR_CLOCK_HZ);
  const spi = new AVRSPI(cpu, spiConfig, AVR_CLOCK_HZ);

  let serialListener = null;
  usart.onByteTransmit = (value) => {
    serialListener?.(value);
  };

  // SPI router: chip-select is plain GPIO, so each registered device is keyed
  // by its CS pin — the device whose CS reads output-low gets the byte, and a
  // CS rising edge resets its frame state. Completion is scheduled at the
  // real transfer length (transferCycles tracks the SPCR clock divider).
  const spiDevices = [];
  const pinStateOf = (unoPin) => {
    const map = UNO_PIN_MAP[unoPin];
    const state = ports[map.port].pinState(map.bit);
    if (state === PinState.High) return { mode: 'output', high: true };
    if (state === PinState.Low) return { mode: 'output', high: false };
    return { mode: 'input', high: false };
  };
  spi.onByte = (mosi) => {
    const selected = spiDevices.find(({ csUnoPin }) => {
      const state = pinStateOf(csUnoPin);
      return state.mode === 'output' && !state.high;
    });
    const miso = selected ? selected.device.onByte(mosi) & 0xff : 0xff;
    cpu.addClockEvent(() => spi.completeTransfer(miso), spi.transferCycles);
  };

  // I2C bus router: ACK only registered slave addresses and forward bytes.
  // Completions are synchronous — the avr8js NoopTWIEventHandler pattern. If
  // re-entrancy ever bites, defer each complete* via cpu.addClockEvent(cb, 1).
  const i2cSlaves = new Map(); // 7-bit address -> {start?, stop?, writeByte, readByte?}
  let activeI2cSlave = null;
  twi.eventHandler = {
    start() {
      twi.completeStart();
    },
    stop() {
      activeI2cSlave?.stop?.();
      activeI2cSlave = null;
      twi.completeStop();
    },
    connectToSlave(addr, write) {
      activeI2cSlave = i2cSlaves.get(addr) ?? null;
      activeI2cSlave?.start?.(write);
      twi.completeConnect(Boolean(activeI2cSlave));
    },
    writeByte(value) {
      activeI2cSlave?.writeByte(value);
      twi.completeWrite(Boolean(activeI2cSlave));
    },
    readByte(ack) {
      twi.completeRead(activeI2cSlave?.readByte?.(ack) ?? 0xff);
    },
  };

  return {
    cpu,
    timers,
    ports,
    adc,
    twi,
    spi,
    registerI2cSlave(address, slave) {
      i2cSlaves.set(address, slave);
    },
    registerSpiDevice(csUnoPin, device) {
      spiDevices.push({ csUnoPin, device });
      const map = UNO_PIN_MAP[csUnoPin];
      ports[map.port].addListener(() => {
        const state = pinStateOf(csUnoPin);
        if (!(state.mode === 'output' && !state.high)) device.onDeselect?.();
      });
    },
    // Feed a byte INTO the sketch's Serial (RX). Returns false when the UART
    // is mid-character or RX is disabled (no Serial.begin yet) — callers
    // queue and retry.
    sendSerialByte(byte) {
      return usart.writeByte(byte) !== false;
    },
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
