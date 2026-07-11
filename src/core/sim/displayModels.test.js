import { describe, expect, it } from 'vitest';
import { createHd44780, createSsd1306 } from './displayModels.js';

// Drive a slave through one I2C transaction (start, bytes, stop).
const transact = (slave, bytes) => {
  slave.start?.(true);
  for (const byte of bytes) slave.writeByte(byte);
  slave.stop?.();
};

describe('createSsd1306', () => {
  it('parses the Adafruit init burst and tracks on/invert', () => {
    const oled = createSsd1306();
    transact(oled.i2cSlave, [0x00,
      0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x8d, 0x14,
      0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0x8f, 0xd9, 0xf1,
      0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf,
    ]);
    expect(oled.state.on).toBe(true);
    expect(oled.state.invert).toBe(false);
    transact(oled.i2cSlave, [0x00, 0xa7]);
    expect(oled.state.invert).toBe(true);
  });

  it('streams display() data across chunked transactions into the framebuffer', () => {
    const oled = createSsd1306();
    // display() preamble: page window 0..7, column window 0..127.
    transact(oled.i2cSlave, [0x00, 0x22, 0x00, 0xff, 0x21, 0x00, 0x7f]);
    // Buffer where byte index i = i & 0xff, streamed in 31-byte Wire chunks.
    const buffer = Array.from({ length: 1024 }, (_, i) => i & 0xff);
    for (let offset = 0; offset < buffer.length; offset += 31) {
      transact(oled.i2cSlave, [0x40, ...buffer.slice(offset, offset + 31)]);
    }
    expect(oled.framebuffer[0]).toBe(0);
    expect(oled.framebuffer[130]).toBe(130 & 0xff);
    expect(oled.framebuffer[1023]).toBe(1023 & 0xff);
    // pixel(x, y): byte 130 = page 1, col 2 → covers rows 8-15 at x=2.
    // 130 & 0xff = 0x82 → bits 1 and 7 → y=9 and y=15 lit.
    expect(oled.pixel(2, 9)).toBe(1);
    expect(oled.pixel(2, 15)).toBe(1);
    expect(oled.pixel(2, 8)).toBe(0);
    expect(oled.state.version).toBeGreaterThan(0);
  });

  it('respects a partial addressing window', () => {
    const oled = createSsd1306();
    transact(oled.i2cSlave, [0x00, 0x22, 0x02, 0x02, 0x21, 0x10, 0x11]);
    transact(oled.i2cSlave, [0x40, 0xff, 0xff, 0xaa]); // wraps within the window
    expect(oled.framebuffer[2 * 128 + 0x10]).toBe(0xaa); // wrapped back to start
    expect(oled.framebuffer[2 * 128 + 0x11]).toBe(0xff);
  });
});

describe('createHd44780', () => {
  // Build the PCF8574 byte stream for one nibble with an E pulse
  // (LiquidCrystal_I2C: write nibble, E high, E low; backlight bit 0x08 on).
  const nibblePulse = (nibble, rs) => {
    const base = ((nibble & 0x0f) << 4) | 0x08 | (rs ? 0x01 : 0);
    return [base | 0x04, base]; // E rising then falling (falling edge latches)
  };
  const byteWrite = (byte, rs) => [
    ...nibblePulse(byte >> 4, rs),
    ...nibblePulse(byte & 0x0f, rs),
  ];

  const begin = (lcd) => {
    // LiquidCrystal_I2C::begin(): three 0x3 pokes, the 0x2 4-bit switch,
    // then function set / display on / clear / entry mode as full bytes.
    const stream = [
      ...nibblePulse(0x3, 0), ...nibblePulse(0x3, 0), ...nibblePulse(0x3, 0),
      ...nibblePulse(0x2, 0),
      ...byteWrite(0x28, 0), ...byteWrite(0x0c, 0), ...byteWrite(0x01, 0), ...byteWrite(0x06, 0),
    ];
    for (const byte of stream) lcd.i2cSlave.writeByte(byte);
  };

  it('initializes via the 4-bit dance and prints text', () => {
    const lcd = createHd44780();
    begin(lcd);
    expect(lcd.state.displayOn).toBe(true);
    for (const char of 'HI') {
      for (const byte of byteWrite(char.charCodeAt(0), 1)) lcd.i2cSlave.writeByte(byte);
    }
    expect(lcd.lines()[0].startsWith('HI')).toBe(true);
    expect(lcd.lines()[0].length).toBe(16);
  });

  it('positions the cursor with DDRAM addressing and clears', () => {
    const lcd = createHd44780();
    begin(lcd);
    // Row 1, col 3 (0x80 | 0x40 + 3).
    for (const byte of byteWrite(0x80 | 0x43, 0)) lcd.i2cSlave.writeByte(byte);
    for (const byte of byteWrite('X'.charCodeAt(0), 1)) lcd.i2cSlave.writeByte(byte);
    expect(lcd.lines()[1][3]).toBe('X');
    for (const byte of byteWrite(0x01, 0)) lcd.i2cSlave.writeByte(byte);
    expect(lcd.lines()[1].trim()).toBe('');
  });

  it('tracks the backlight bit on every byte', () => {
    const lcd = createHd44780();
    begin(lcd);
    expect(lcd.state.backlight).toBe(true);
    lcd.i2cSlave.writeByte(0x00); // backlight bit clear
    expect(lcd.state.backlight).toBe(false);
  });
});
