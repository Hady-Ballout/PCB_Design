// Deterministic uuid so the same input always serializes identically (stable
// for tests and for change detection in generated KiCad files). Shared by
// kicadSchematic.js and kicadPcb.js.
export const uuidFrom = (seed) => {
  const text = String(seed);
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
    h3 = Math.imul(h3 ^ code, 2246822519);
    h4 = Math.imul(h4 ^ code, 3266489917);
  }
  const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');
  const raw = hex(h1) + hex(h2) + hex(h3) + hex(h4);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
};
