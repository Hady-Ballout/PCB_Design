// Minimal store-only (method 0) ZIP writer.
//
// The fabrication export ships a folder of Gerber/Excellon text files, and every
// fab house's upload form wants exactly one .zip. Deflate would buy nothing here
// (the payload is already tiny, and vendors accept stored entries), so this
// writes the simplest archive the format allows: local file header, raw bytes,
// central directory, end-of-central-directory. No dependencies, no streams.
//
// Every entry carries a FIXED DOS timestamp (2020-01-01 00:00). A ZIP is the one
// place a clock would leak into an otherwise deterministic pipeline, and a
// fabrication archive that differs byte-for-byte between two runs of the same
// design can't be diffed, cached, or checksummed against what was ordered.

/** Standard CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// MS-DOS packed date/time: date = ((year - 1980) << 9) | (month << 5) | day,
// time = (hour << 11) | (minute << 5) | (second / 2).
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const encoder = new TextEncoder();

const toBytes = (data) => (typeof data === 'string' ? encoder.encode(data) : Uint8Array.from(data));

/**
 * Assembles a store-only ZIP archive.
 *
 * @param {Array<{ name: string, data: string | Uint8Array }>} files entry order
 *   is preserved; strings are encoded as UTF-8.
 * @returns {Uint8Array}
 */
export const zipStore = (files) => {
  const entries = files.map((file) => {
    const name = encoder.encode(String(file.name));
    const data = toBytes(file.data);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  const localSize = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let cursor = 0;

  const u16 = (value) => { view.setUint16(cursor, value, true); cursor += 2; };
  const u32 = (value) => { view.setUint32(cursor, value >>> 0, true); cursor += 4; };
  const raw = (bytes) => { output.set(bytes, cursor); cursor += bytes.length; };

  for (const entry of entries) {
    entry.offset = cursor;
    u32(0x04034b50);
    u16(20); // version needed to extract: 2.0
    u16(0x0800); // general purpose flags: bit 11 = UTF-8 filename
    u16(0); // method 0 = stored
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); // extra field length
    raw(entry.name);
    raw(entry.data);
  }

  const centralOffset = cursor;
  for (const entry of entries) {
    u32(0x02014b50);
    u16(20); // version made by
    u16(20); // version needed to extract
    u16(0x0800);
    u16(0);
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); // extra field length
    u16(0); // file comment length
    u16(0); // disk number start
    u16(0); // internal file attributes
    u32(0); // external file attributes
    u32(entry.offset);
    raw(entry.name);
  }

  // Captured before the EOCD itself is written — `cursor` moves as we go.
  const centralEnd = cursor;
  u32(0x06054b50);
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(entries.length);
  u16(entries.length);
  u32(centralEnd - centralOffset);
  u32(centralOffset);
  u16(0); // archive comment length

  return output;
};
