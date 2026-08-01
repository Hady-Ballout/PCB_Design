// Pure helpers for the "Connect to Claude" page.
//
// Kept out of the component so the URL derivation — the part that is easy to get
// wrong and that users paste into another product — is testable on its own.

/**
 * The MCP endpoint a client connects to.
 *
 * In production the frontend and API share an origin, so the page's own origin is
 * right. In local development Vite serves on 5174 and proxies /api to 8787, so the
 * proxied path still resolves — but a Claude client connects directly, not through
 * the dev server, which is why an explicit override exists.
 */
export const mcpEndpointUrl = ({ origin, configuredBase } = {}) => {
  const base = (configuredBase || origin || '').replace(/\/+$/, '');
  return `${base}/api/mcp`;
};

/** The one-liner for Claude Code. */
export const claudeCodeCommand = (url) => `claude mcp add --transport http pcb-pilot ${url}`;

/**
 * Steps for clients that take a URL in their own UI rather than a CLI. Written as
 * data so the component stays presentational.
 */
export const desktopSteps = [
  'Open Claude Desktop or claude.ai',
  'Go to Settings → Connectors',
  'Choose "Add custom connector"',
  'Paste the URL above and confirm',
  'Sign in when Claude opens the authorization page',
];

/**
 * What the user can actually ask for once connected — concrete phrasings beat an
 * abstract tool list, which they would have to translate themselves.
 */
export const examplePrompts = [
  'Design a 5V RC low-pass filter, validate it, and simulate the step response.',
  'Check this circuit for missing flyback diodes and floating MOSFET gates.',
  'Export my current design as a KiCad schematic.',
  'Lay out a two-layer board for this circuit and tell me the board size.',
];
