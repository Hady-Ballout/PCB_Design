// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AUTH_PAGES, PUBLIC_PAGES, pageFromHash } from './routing.js';

describe('pageFromHash', () => {
  it('routes the auth pages', () => {
    window.location.hash = '#home';
    expect(pageFromHash()).toBe('home');
    window.location.hash = '#login';
    expect(pageFromHash()).toBe('login');
    window.location.hash = '#signup';
    expect(pageFromHash()).toBe('signup');
  });

  it('routes #connect to the MCP connection page', () => {
    window.location.hash = '#connect';
    expect(pageFromHash()).toBe('connect');
  });

  it('routes #verify (with a token query) to the verify page', () => {
    window.location.hash = '#verify?token=abc123';
    expect(pageFromHash()).toBe('verify');
  });

  it('opens the workspace from #app, empty, and unknown hashes', () => {
    window.location.hash = '#app';
    expect(pageFromHash()).toBe('workspace');
    window.location.hash = '';
    expect(pageFromHash()).toBe('workspace');
    window.location.hash = '#billing=success';
    expect(pageFromHash()).toBe('workspace');
  });

  it('keeps the waveform page', () => {
    window.location.hash = '#waveform';
    expect(pageFromHash()).toBe('waveform');
  });
});

describe('page sets', () => {
  it('marks login and signup as auth pages', () => {
    expect(AUTH_PAGES.has('login')).toBe(true);
    expect(AUTH_PAGES.has('signup')).toBe(true);
  });

  it('lets logged-out visitors reach home, login, signup, and verify', () => {
    expect(PUBLIC_PAGES.has('home')).toBe(true);
    expect(PUBLIC_PAGES.has('verify')).toBe(true);
    expect(PUBLIC_PAGES.has('workspace')).toBe(false);
  });
});
