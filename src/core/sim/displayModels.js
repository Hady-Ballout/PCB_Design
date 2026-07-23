// Pure protocol parsers for the I2C display peripherals — no engine or avr8js
// imports so they unit-test in isolation. Each exposes an `i2cSlave` object
// the AVR runner's bus router drives ({start, writeByte, stop}).

// SSD1306 128×64 OLED, modeling exactly the subset Adafruit_SSD1306 uses:
// every transaction starts with a control byte (0x00 = command stream,
// 0x40 = data stream — re-sent by every 32-byte Wire chunk), commands that
// matter are the column/page windows and on/off/invert, and display() streams
// the 1024-byte buffer in horizontal addressing (page-major, LSB = top pixel).
export const createSsd1306 = () => {
  const framebuffer = new Uint8Array(1024);
  const state = { on: false, invert: false, version: 0 };
  let colStart = 0;
  let colEnd = 127;
  let pageStart = 0;
  let pageEnd = 7;
  let col = 0;
  let page = 0;
  let mode = null; // 'command' | 'data' | null (before the control byte)
  let pendingCommand = null; // {opcode, argsLeft, args}
  let wroteData = false;

  // Commands with argument bytes we consume (only 0x21/0x22 are acted on).
  const ARG_COUNTS = { 0x21: 2, 0x22: 2, 0x81: 1, 0x8d: 1, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x20: 1 };

  const runCommand = (opcode, args) => {
    if (opcode === 0x21) {
      [colStart, colEnd] = args;
      col = colStart;
    } else if (opcode === 0x22) {
      [pageStart, pageEnd] = args;
      pageEnd = Math.min(pageEnd, 7);
      page = pageStart;
    } else if (opcode === 0xae) state.on = false;
    else if (opcode === 0xaf) state.on = true;
    else if (opcode === 0xa6) state.invert = false;
    else if (opcode === 0xa7) state.invert = true;
    // Everything else (clock div, charge pump, contrast, remap…) is ignored.
  };

  const command = (byte) => {
    if (pendingCommand) {
      pendingCommand.args.push(byte);
      if (pendingCommand.args.length === pendingCommand.argsLeft) {
        runCommand(pendingCommand.opcode, pendingCommand.args);
        pendingCommand = null;
      }
      return;
    }
    const argCount = ARG_COUNTS[byte] ?? 0;
    if (argCount > 0) pendingCommand = { opcode: byte, argsLeft: argCount, args: [] };
    else runCommand(byte, []);
  };

  const data = (byte) => {
    framebuffer[page * 128 + col] = byte;
    wroteData = true;
    col += 1;
    if (col > colEnd) {
      col = colStart;
      page = page + 1 > pageEnd ? pageStart : page + 1;
    }
  };

  return {
    framebuffer,
    state,
    pixel: (x, y) => (framebuffer[(y >> 3) * 128 + x] >> (y & 7)) & 1,
    i2cSlave: {
      start() {
        mode = null;
      },
      writeByte(value) {
        if (mode == null) {
          mode = value === 0x40 ? 'data' : 'command';
          return;
        }
        if (mode === 'data') data(value);
        else command(value);
      },
      stop() {
        mode = null;
        if (wroteData) {
          wroteData = false;
          state.version += 1;
        }
      },
    },
  };
};

// PCF8574 backpack + HD44780 16×2, modeling the LiquidCrystal_I2C wiring:
// P0=RS, P1=RW, P2=E, P3=backlight, P4-7=data nibble. A nibble latches on the
// E falling edge; two latches make a byte (high nibble first) — except during
// the 4-bit init dance, handled by staying in one-nibble mode until the first
// 0x2x function-set nibble arrives.
export const createHd44780 = () => {
  const ddram = new Uint8Array(128).fill(0x20); // spaces
  const cgram = new Uint8Array(64);
  const state = { backlight: true, displayOn: false, version: 0 };
  let cursor = 0;
  let cgramMode = false;
  let lastPort = 0;
  let paired = false; // two-nibble mode established?
  let highNibble = null;

  const execute = (byte, rs) => {
    state.version += 1;
    if (rs) {
      if (cgramMode) cgram[cursor & 0x3f] = byte;
      else ddram[cursor & 0x7f] = byte;
      cursor += 1;
      return;
    }
    if (byte === 0x01) {
      ddram.fill(0x20);
      cursor = 0;
      cgramMode = false;
    } else if ((byte & 0xfe) === 0x02) {
      cursor = 0;
      cgramMode = false;
    } else if (byte & 0x80) {
      cursor = byte & 0x7f;
      cgramMode = false;
    } else if (byte & 0x40) {
      cursor = byte & 0x3f;
      cgramMode = true;
    } else if (byte & 0x08) {
      state.displayOn = Boolean(byte & 0x04);
    }
    // Entry mode (0x04|) and function set (0x20|) need no further modeling.
  };

  const latchNibble = (nibble, rs) => {
    if (!paired) {
      // 4-bit init: single 0x3 pokes, then the 0x2 that enters 4-bit mode.
      if (nibble === 0x2) {
        paired = true;
        highNibble = null;
      }
      return;
    }
    if (highNibble == null) {
      highNibble = nibble;
      return;
    }
    const byte = (highNibble << 4) | nibble;
    highNibble = null;
    execute(byte, rs);
  };

  return {
    state,
    lines: () => [0x00, 0x40].map((offset) =>
      Array.from({ length: 16 }, (_, i) => {
        const code = ddram[offset + i];
        return code < 8 ? '█' : String.fromCharCode(code);
      }).join('')),
    i2cSlave: {
      writeByte(value) {
        state.backlight = Boolean(value & 0x08);
        const fell = (lastPort & 0x04) && !(value & 0x04); // E falling edge
        lastPort = value;
        if (fell) latchNibble((value >> 4) & 0x0f, value & 0x01);
      },
    },
  };
};
