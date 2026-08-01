import { describe, expect, it } from 'vitest';
import { claudeCodeCommand, mcpEndpointUrl } from './connectInstructions.js';

describe('mcpEndpointUrl', () => {
  it('derives the endpoint from the page origin', () => {
    expect(mcpEndpointUrl({ origin: 'https://impedo.ai' })).toBe('https://impedo.ai/api/mcp');
  });

  it('prefers an explicit override, since a Claude client does not go through the dev proxy', () => {
    expect(mcpEndpointUrl({ origin: 'http://127.0.0.1:5174', configuredBase: 'https://api.impedo.ai' }))
      .toBe('https://api.impedo.ai/api/mcp');
  });

  it('does not double up the slash when the base already ends with one', () => {
    expect(mcpEndpointUrl({ origin: 'https://impedo.ai/' })).toBe('https://impedo.ai/api/mcp');
  });

  it('degrades to a relative path rather than emitting "undefined/api/mcp"', () => {
    expect(mcpEndpointUrl({})).toBe('/api/mcp');
  });
});

describe('claudeCodeCommand', () => {
  it('names the server and the transport', () => {
    expect(claudeCodeCommand('https://impedo.ai/api/mcp'))
      .toBe('claude mcp add --transport http pcb-pilot https://impedo.ai/api/mcp');
  });
});
