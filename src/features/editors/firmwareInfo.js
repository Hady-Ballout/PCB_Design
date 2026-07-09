// Pure lookup from a circuit to the firmware metadata for its microcontroller
// board (if any) — display name, language, download filename/MIME type. The
// actual firmware source text lives on the AI response's `code` field and
// flows through chat state as plain text; this module never holds it.
import { MCU_KINDS } from '../../core/pcbGenerator.js';

export const FIRMWARE_TARGETS = {
  arduino_uno: { boardName: 'Arduino Uno', language: 'Arduino C++', filename: 'sketch.ino', mime: 'text/plain' },
  esp32: { boardName: 'ESP32', language: 'Arduino C++', filename: 'sketch.ino', mime: 'text/plain' },
  raspberry_pi: { boardName: 'Raspberry Pi', language: 'Python (gpiozero)', filename: 'gpio_script.py', mime: 'text/x-python' },
};

// A circuit with two MCU boards only gets firmware info for the first one
// found, in component array order — matching the AI's own single-`code`-field
// contract (server/ai/ollamaProvider.ts writes firmware for one board).
export const firmwareTargetForCircuit = (circuit) => {
  const mcu = (circuit?.components || []).find((part) => MCU_KINDS.has(part.kind));
  return mcu ? { ref: mcu.ref, kind: mcu.kind, ...FIRMWARE_TARGETS[mcu.kind] } : null;
};
