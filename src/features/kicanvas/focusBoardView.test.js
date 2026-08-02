import { describe, expect, test } from 'vitest';
import { focusBoardView } from './KiCanvasEmbed.jsx';

// The embed builds its viewer asynchronously behind two open shadow roots;
// these fakes mimic that chain without loading the vendor bundle.
function fakeEmbed(viewer, { appearAfterPolls = 0 } = {}) {
  let polls = 0;
  return {
    isConnected: true,
    shadowRoot: {
      querySelector(selector) {
        if (selector !== 'kc-board-app') return null;
        polls += 1;
        if (polls <= appearAfterPolls) return null;
        return {
          shadowRoot: {
            querySelector: (inner) => (inner === 'kc-board-viewer' ? { viewer } : null),
          },
        };
      },
    },
  };
}

function fakeViewer(calls) {
  return {
    loaded: Promise.resolve(true),
    set page_opacity(value) {
      calls.push(['page_opacity', value]);
    },
    zoom_to_board: () => calls.push(['zoom_to_board']),
    draw: () => calls.push(['draw']),
  };
}

describe('focusBoardView', () => {
  test('hides the drawing sheet, zooms to the board, then redraws', async () => {
    const calls = [];
    const embed = fakeEmbed(fakeViewer(calls));

    await expect(focusBoardView(embed)).resolves.toBe(true);
    expect(calls).toEqual([['page_opacity', 0], ['zoom_to_board'], ['draw']]);
  });

  test('keeps polling until the async viewer appears', async () => {
    const calls = [];
    const embed = fakeEmbed(fakeViewer(calls), { appearAfterPolls: 2 });

    await expect(focusBoardView(embed, { pollMs: 1 })).resolves.toBe(true);
    expect(calls).toEqual([['page_opacity', 0], ['zoom_to_board'], ['draw']]);
  });

  test('gives up quietly when no board viewer ever appears', async () => {
    const embed = {
      isConnected: true,
      shadowRoot: { querySelector: () => null },
    };

    await expect(focusBoardView(embed, { pollMs: 1, timeoutMs: 10 })).resolves.toBe(false);
  });

  test('stops polling once the embed leaves the document', async () => {
    const embed = {
      isConnected: false,
      shadowRoot: { querySelector: () => null },
    };

    await expect(focusBoardView(embed, { pollMs: 1, timeoutMs: 5000 })).resolves.toBe(false);
  });
});
