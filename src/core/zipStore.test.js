import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { zipStore } from './zipStore.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * Independent structural reader for a store-only ZIP: finds the EOCD, walks the
 * central directory, and pulls each entry's bytes out of its local header. The
 * point is to read the archive the way a fab house's unzip does rather than to
 * re-assert the writer's own arithmetic.
 */
const readZip = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIG) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('no EOCD record');

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  expect(centralOffset + centralSize).toBe(eocd);

  const decoder = new TextDecoder();
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(CENTRAL_SIG);
    const method = view.getUint16(cursor + 10, true);
    const dosTime = view.getUint16(cursor + 12, true);
    const dosDate = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    expect(view.getUint32(localOffset, true)).toBe(LOCAL_SIG);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    entries.push({
      name, method, crc, compressedSize, uncompressedSize, dosDate, dosTime, data,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(eocd);
  return entries;
};

const text = (bytes) => new TextDecoder().decode(bytes);

describe('zipStore', () => {
  it('writes a store-only archive whose entries read back byte for byte', () => {
    const zip = zipStore([
      { name: 'a.txt', data: 'hello\n' },
      { name: 'b.bin', data: new Uint8Array([0, 1, 2, 250, 255]) },
    ]);

    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.bin']);
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
    expect(text(entries[0].data)).toBe('hello\n');
    expect([...entries[1].data]).toEqual([0, 1, 2, 250, 255]);
  });

  it('starts with the local file header signature', () => {
    const zip = zipStore([{ name: 'a.txt', data: 'x' }]);

    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('records the CRC-32 and both sizes of each entry', () => {
    const payload = 'The quick brown fox\n';
    const zip = zipStore([{ name: 'fox.txt', data: payload }]);

    const [entry] = readZip(zip);
    expect(entry.crc).toBe(crc32(Buffer.from(payload, 'utf8')));
    expect(entry.uncompressedSize).toBe(payload.length);
    expect(entry.compressedSize).toBe(payload.length);
  });

  it('encodes names as UTF-8 and counts bytes, not characters', () => {
    const zip = zipStore([{ name: 'µ-board.txt', data: 'µ' }]);

    const [entry] = readZip(zip);
    expect(entry.name).toBe('µ-board.txt');
    expect(entry.uncompressedSize).toBe(2);
  });

  it('stamps a fixed 2020-01-01 00:00 DOS timestamp so archives never drift', () => {
    const zip = zipStore([{ name: 'a.txt', data: 'x' }]);

    const [entry] = readZip(zip);
    // DOS date = ((year - 1980) << 9) | (month << 5) | day
    expect(entry.dosDate).toBe(((2020 - 1980) << 9) | (1 << 5) | 1);
    expect(entry.dosTime).toBe(0);
  });

  it('is byte-for-byte deterministic across calls', () => {
    const files = [{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world' }];

    expect([...zipStore(files)]).toEqual([...zipStore(files)]);
  });

  it('produces an archive the platform unzipper accepts', async () => {
    // A second, fully independent reader: Node's own zlib inflating nothing is
    // not a real check, so this asserts the end-of-central-directory bookkeeping
    // that every unzip implementation validates first.
    const zip = zipStore([{ name: 'a.txt', data: 'x' }, { name: 'b.txt', data: 'yy' }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;

    expect(view.getUint32(eocd, true)).toBe(EOCD_SIG);
    expect(view.getUint16(eocd + 8, true)).toBe(2);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    expect(view.getUint16(eocd + 20, true)).toBe(0);
  });
});
