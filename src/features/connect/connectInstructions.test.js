import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, endpointWarning, mcpEndpointUrl } from './connectInstructions.js';

describe('mcpEndpointUrl', () => {
  it('uses the API base rather than the page origin', () => {
    // impedo.ai is Firebase Hosting (which rewrites everything to index.html) with
    // the API on a separate Render service. Using the page origin here would hand
    // the user a URL that serves the SPA's HTML.
    expect(mcpEndpointUrl({ origin: 'https://impedo.ai', apiBase: 'https://api.impedo.ai' }))
      .toBe('https://api.impedo.ai/api/mcp');
  });

  it('falls back to the page origin when the API is same-origin', () => {
    expect(mcpEndpointUrl({ origin: 'https://impedo.ai', apiBase: '' }))
      .toBe('https://impedo.ai/api/mcp');
  });

  it('lets an explicit override win over both', () => {
    expect(mcpEndpointUrl({
      origin: 'https://impedo.ai',
      apiBase: 'https://api.impedo.ai',
      configuredBase: 'https://mcp.impedo.ai',
    })).toBe('https://mcp.impedo.ai/api/mcp');
  });

  it('does not double up the slash when the base already ends with one', () => {
    expect(mcpEndpointUrl({ apiBase: 'https://api.impedo.ai/' })).toBe('https://api.impedo.ai/api/mcp');
  });

  it('degrades to a relative path rather than emitting "undefined/api/mcp"', () => {
    expect(mcpEndpointUrl({})).toBe('/api/mcp');
  });
});

describe('endpointWarning', () => {
  it('stays silent for a public https endpoint', () => {
    expect(endpointWarning('https://api.impedo.ai/api/mcp')).toBeNull();
  });

  it('explains that a localhost URL cannot be pasted into Claude', () => {
    const warning = endpointWarning('http://127.0.0.1:5174/api/mcp');

    expect(warning).toMatch(/local development/i);
    expect(warning).toMatch(/stdio/i);
  });

  it('treats a bare relative path as local too', () => {
    expect(endpointWarning('/api/mcp')).toMatch(/local development/i);
  });

  it('warns about any other non-https endpoint', () => {
    expect(endpointWarning('http://staging.impedo.ai/api/mcp')).toMatch(/https/i);
  });
});

describe('claudeCodeCommand', () => {
  it('names the server and the transport', () => {
    expect(claudeCodeCommand('https://api.impedo.ai/api/mcp'))
      .toBe('claude mcp add --transport http pcb-pilot https://api.impedo.ai/api/mcp');
  });
});
