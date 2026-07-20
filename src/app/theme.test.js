// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, applyTheme, loadTheme, saveTheme, systemTheme } from './theme.js';

const matchMediaPreferring = (dark) => () => ({ matches: dark });

describe('theme selection', () => {
  let storage;

  beforeEach(() => {
    const backing = new Map();
    storage = {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, String(value)),
    };
  });

  it('prefers the stored theme over the OS preference', () => {
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(loadTheme(storage, matchMediaPreferring(false))).toBe('dark');
  });

  it('falls back to the OS preference when nothing is stored', () => {
    expect(loadTheme(storage, matchMediaPreferring(true))).toBe('dark');
    expect(loadTheme(storage, matchMediaPreferring(false))).toBe('light');
  });

  it('ignores invalid stored values', () => {
    storage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(loadTheme(storage, matchMediaPreferring(false))).toBe('light');
  });

  it('survives an unavailable or throwing storage', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadTheme(broken, matchMediaPreferring(true))).toBe('dark');
    expect(() => saveTheme('dark', broken)).not.toThrow();
    expect(loadTheme(undefined, matchMediaPreferring(false))).toBe('light');
  });

  it('defaults to light when matchMedia is missing', () => {
    expect(systemTheme(undefined)).toBe('light');
  });

  it('round-trips through saveTheme', () => {
    saveTheme('dark', storage);
    expect(loadTheme(storage, matchMediaPreferring(false))).toBe('dark');
  });

  it('applyTheme stamps the html element and meta theme-color', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(meta.getAttribute('content')).toBe('#171512');

    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(meta.getAttribute('content')).toBe('#faf3e8');

    meta.remove();
  });
});
