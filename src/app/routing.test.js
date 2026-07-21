// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PUBLIC_PAGES, pageFromHash } from './routing.js';

describe('pageFromHash', () => {
  it('routes #pricing to the pricing page', () => {
    window.location.hash = '#pricing';
    expect(pageFromHash()).toBe('pricing');
  });

  it('keeps existing routes intact', () => {
    window.location.hash = '#home';
    expect(pageFromHash()).toBe('home');
    window.location.hash = '#login';
    expect(pageFromHash()).toBe('login');
    window.location.hash = '';
    expect(pageFromHash()).toBe('workspace');
  });

  it('treats a checkout return hash as the workspace', () => {
    window.location.hash = '#billing=success';
    expect(pageFromHash()).toBe('workspace');
  });
});

describe('PUBLIC_PAGES', () => {
  it('lets logged-out visitors see the pricing page', () => {
    expect(PUBLIC_PAGES.has('pricing')).toBe(true);
  });
});
