// Maps a circuit's microcontroller board to the firmware language, download
// filename, and display labels used by the Code editor tab. Pure module so it
// stays unit-testable.
import { MCU_KINDS } from '../../core/pcbGenerator.js';

export const FIRMWARE_TARGETS = {
  arduino_uno: { boardName: 'Arduino Uno', language: 'Arduino C++', filename: 'sketch.ino', mime: 'text/plain' },
  esp32: { boardName: 'ESP32', language: 'Arduino C++', filename: 'sketch.ino', mime: 'text/plain' },
  raspberry_pi: { boardName: 'Raspberry Pi', language: 'Python (gpiozero)', filename: 'gpio_script.py', mime: 'text/x-python' },
};

// The first MCU in components wins; circuits with two boards get firmware for
// one of them only (known limitation). Returns null when the circuit has no
// microcontroller board.
export const firmwareTargetForCircuit = (circuit) => {
  const mcu = (circuit?.components || []).find((part) => MCU_KINDS.has(part.kind));
  return mcu ? { ref: mcu.ref, kind: mcu.kind, ...FIRMWARE_TARGETS[mcu.kind] } : null;
};
