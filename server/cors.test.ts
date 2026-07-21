import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins, resolveCorsOrigin } from './cors.js';

describe('parseAllowedOrigins', () => {
  it('splits a comma-separated CORS_ORIGIN into individual origins', () => {
    expect(parseAllowedOrigins('https://impedo.ai,https://www.impedo.ai,https://pcb-pilot.web.app'))
      .toEqual(['https://impedo.ai', 'https://www.impedo.ai', 'https://pcb-pilot.web.app']);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(parseAllowedOrigins(' https://impedo.ai , ,https://www.impedo.ai, '))
      .toEqual(['https://impedo.ai', 'https://www.impedo.ai']);
  });

  it('falls back to the dev origin when unset or blank', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['http://127.0.0.1:5174']);
    expect(parseAllowedOrigins('')).toEqual(['http://127.0.0.1:5174']);
  });
});

describe('resolveCorsOrigin', () => {
  const allowed = ['https://impedo.ai', 'https://www.impedo.ai', 'https://pcb-pilot.web.app'];

  it('echoes the request origin when it is on the allowlist', () => {
    expect(resolveCorsOrigin(allowed, 'https://www.impedo.ai')).toBe('https://www.impedo.ai');
    expect(resolveCorsOrigin(allowed, 'https://pcb-pilot.web.app')).toBe('https://pcb-pilot.web.app');
  });

  it('returns the primary origin for a disallowed origin so the browser blocks it', () => {
    expect(resolveCorsOrigin(allowed, 'https://evil.example')).toBe('https://impedo.ai');
  });

  it('returns the primary origin when the request has no Origin header', () => {
    expect(resolveCorsOrigin(allowed, undefined)).toBe('https://impedo.ai');
  });
});
