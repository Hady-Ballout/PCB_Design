// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pageFromHash } from './routing.js';

describe('pageFromHash', () => {
  it('shows the landing page when there is no hash', () => {
    window.location.hash = '';
    expect(pageFromHash()).toBe('home');
    window.location.hash = '#home';
    expect(pageFromHash()).toBe('home');
  });

  it('opens the workspace from #app and unknown hashes', () => {
    window.location.hash = '#app';
    expect(pageFromHash()).toBe('workspace');
    window.location.hash = '#billing=success';
    expect(pageFromHash()).toBe('workspace');
  });

  it('keeps the waveform page', () => {
    window.location.hash = '#waveform';
    expect(pageFromHash()).toBe('waveform');
  });
});
