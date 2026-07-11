// Extracts a curated set of symbols from the official KiCad 6 symbol
// libraries into src/core/kicadSymbolLibrary.js so the schematic exporter can
// embed real library symbols (instead of hand-drawn ones) in generated
// .kicad_sch files.
//
// Usage:
//   node scripts/extract-kicad-symbols.mjs <dir-with-.kicad_sym-files>
//
// The source libraries are not committed (they are several MB); download them
// from https://gitlab.com/kicad/libraries/kicad-symbols (tag 6.0.11), e.g.:
//   curl -sLO https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/6.0.11/Device.kicad_sym
//
// The KiCad symbol libraries are licensed CC-BY-SA 4.0 with the KiCad libraries
// exception; see https://www.kicad.org/libraries/license/
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const WANTED = {
  Device: ['R', 'C', 'L', 'D', 'LED', 'Q_NPN_BCE', 'Q_PNP_BCE', 'Q_NMOS_GDS', 'Q_PMOS_GDS'],
  power: ['GND'],
  pspice: ['VSOURCE'],
  Amplifier_Operational: ['LM741'],
  Regulator_Linear: ['L7805'],
};

// --- Minimal s-expression parser (enough for .kicad_sym files). ---
const tokenize = (text) => {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '(' || char === ')') {
      tokens.push(char);
      index += 1;
    } else if (char === '"') {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          value += text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ str: value });
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      let value = '';
      while (index < text.length && !/[\s()"]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ atom: value });
    }
  }
  return tokens;
};

const parse = (text) => {
  const tokens = tokenize(text);
  let index = 0;
  const walk = () => {
    const token = tokens[index];
    index += 1;
    if (token === '(') {
      const list = [];
      while (tokens[index] !== ')') list.push(walk());
      index += 1;
      return list;
    }
    return token;
  };
  return walk();
};

const isList = (node) => Array.isArray(node);
const head = (node) => (isList(node) && node[0]?.atom) || null;
const str = (node) => node?.str;
const num = (node) => Number(node?.atom ?? node?.str);

// --- Extraction ---
const findSymbol = (lib, name) =>
  lib.filter((node) => head(node) === 'symbol').find((node) => str(node[1]) === name);

// Raw source slice for a symbol block, so formatting survives verbatim.
const rawSymbolBlock = (source, name) => {
  const needle = `(symbol "${name}"`;
  const start = source.indexOf(needle);
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '"') {
      index += 1;
      while (source[index] !== '"') index += source[index] === '\\' ? 2 : 1;
    } else if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
};

const collectPins = (symbolNode) => {
  const pins = [];
  for (const unit of symbolNode.filter((node) => head(node) === 'symbol')) {
    for (const pin of unit.filter((node) => head(node) === 'pin')) {
      const at = pin.find((node) => head(node) === 'at');
      const length = pin.find((node) => head(node) === 'length');
      const name = pin.find((node) => head(node) === 'name');
      const number = pin.find((node) => head(node) === 'number');
      pins.push({
        number: str(number?.[1]) ?? '',
        name: str(name?.[1]) ?? '',
        x: num(at?.[1]),
        y: num(at?.[2]),
        angle: num(at?.[3]) || 0,
        length: num(length?.[1]) || 0,
      });
    }
  }
  return pins;
};

const collectBounds = (symbolNode, pins) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const visit = (node) => {
    if (!isList(node)) return;
    const kind = head(node);
    if (kind === 'xy' || kind === 'start' || kind === 'end' || kind === 'mid') {
      extend(num(node[1]), num(node[2]));
    }
    if (kind === 'circle') {
      const center = node.find((child) => head(child) === 'center');
      const radius = num(node.find((child) => head(child) === 'radius')?.[1]);
      if (center) {
        extend(num(center[1]) - radius, num(center[2]) - radius);
        extend(num(center[1]) + radius, num(center[2]) + radius);
      }
    }
    node.forEach(visit);
  };
  for (const unit of symbolNode.filter((node) => head(node) === 'symbol')) visit(unit);
  for (const pin of pins) extend(pin.x, pin.y);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
};

const main = () => {
  const libDir = process.argv[2];
  if (!libDir) {
    console.error('Usage: node scripts/extract-kicad-symbols.mjs <dir-with-.kicad_sym-files>');
    process.exit(1);
  }
  const entries = {};
  for (const [libName, symbolNames] of Object.entries(WANTED)) {
    const file = path.join(libDir, `${libName}.kicad_sym`);
    const source = fs.readFileSync(file, 'utf8');
    const lib = parse(source);
    for (const symbolName of symbolNames) {
      const node = findSymbol(lib, symbolName);
      if (!node) throw new Error(`${libName}:${symbolName} not found`);
      if (node.some((child) => head(child) === 'extends')) {
        throw new Error(`${libName}:${symbolName} uses (extends ...); flattening not implemented`);
      }
      const raw = rawSymbolBlock(source, symbolName);
      if (!raw) throw new Error(`${libName}:${symbolName} raw block not found`);
      const libId = `${libName}:${symbolName}`;
      // Embedded lib_symbols use the fully qualified id; unit children keep
      // their original "NAME_u_s" names, which KiCad and KiCanvas accept.
      const def = raw.replace(`(symbol "${symbolName}"`, `(symbol "${libId}"`);
      const pins = collectPins(node);
      entries[libId] = { def, pins, bounds: collectBounds(node, pins) };
    }
  }

  const out = [];
  out.push('// Generated by scripts/extract-kicad-symbols.mjs — do not edit by hand.');
  out.push('//');
  out.push('// Symbols from the official KiCad 6 symbol libraries (tag 6.0.11),');
  out.push('// https://gitlab.com/kicad/libraries/kicad-symbols');
  out.push('// Licensed CC-BY-SA 4.0 with the KiCad libraries exception:');
  out.push('// https://www.kicad.org/libraries/license/');
  out.push('//');
  out.push('// Each entry: def — verbatim (symbol ...) block for lib_symbols;');
  out.push('// pins — symbol-local pin connect points (mm, y-up) keyed by number;');
  out.push('// bounds — symbol-local bounding box (mm, y-up).');
  out.push('export const KICAD_SYMBOLS = {');
  for (const [libId, entry] of Object.entries(entries)) {
    out.push(`  ${JSON.stringify(libId)}: {`);
    out.push(`    def: ${JSON.stringify(entry.def)},`);
    out.push(`    pins: ${JSON.stringify(
      Object.fromEntries(entry.pins.map((pin) => [pin.number, pin])),
    )},`);
    out.push(`    bounds: ${JSON.stringify(entry.bounds)},`);
    out.push('  },');
  }
  out.push('};');
  out.push('');
  const target = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'core', 'kicadSymbolLibrary.js')
    .replace(/^[/\\]([A-Za-z]:)/, '$1');
  fs.writeFileSync(target, out.join('\n'));
  console.log(`Wrote ${target} with ${Object.keys(entries).length} symbols`);
};

main();
