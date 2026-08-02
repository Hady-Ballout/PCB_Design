// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from './download.js';

const stubObjectUrl = () => {
  const created = [];
  const revoked = [];
  URL.createObjectURL = vi.fn((blob) => {
    created.push(blob);
    return `blob:mock/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
  return { created, revoked };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('downloadBlob', () => {
  it('offers the bytes under the requested filename and mime type', () => {
    const { created } = stubObjectUrl();
    const clicks = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() { clicks.push(this); };

    try {
      downloadBlob('board-gerbers.zip', new Uint8Array([0x50, 0x4b]), 'application/zip');
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }

    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('board-gerbers.zip');
    expect(created[0].type).toBe('application/zip');
    expect(created[0].size).toBe(2);
  });

  it('removes the anchor and revokes the object URL it created', () => {
    vi.useFakeTimers();
    const { revoked } = stubObjectUrl();
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};

    try {
      downloadBlob('a.zip', new Uint8Array([1]), 'application/zip');
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }

    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(revoked).toEqual(['blob:mock/1']);
  });
});
