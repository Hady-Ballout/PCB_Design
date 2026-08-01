// Pure helpers for the "Connect to Claude" page.
//
// Kept out of the component so the URL derivation — the part that is easy to get
// wrong and that users paste into another product — is testable on its own.

/**
 * The MCP endpoint a client connects to.
 *
 * Resolution order matters, and the page origin is deliberately last:
 *
 *   1. VITE_MCP_BASE_URL — explicit override
 *   2. VITE_API_URL (API_BASE) — where the app already sends its own API calls
 *   3. the page origin — only correct when frontend and API share a host
 *
 * On impedo.ai they do NOT share a host: the frontend is Firebase Hosting, which
 * rewrites every path to /index.html, and the API is a separate Render service.
 * Deriving this from window.location.origin there would hand the user
 * `https://impedo.ai/api/mcp`, which returns the SPA's HTML — a URL that looks
 * plausible and fails confusingly inside Claude.
 */
export const mcpEndpointUrl = ({ origin, apiBase, configuredBase } = {}) => {
  const base = (configuredBase || apiBase || origin || '').replace(/\/+$/, '');
  return `${base}/api/mcp`;
};

/**
 * Remote MCP servers must be HTTPS — Claude rejects an http:// connector outright.
 * A localhost URL is therefore never pasteable, and saying so on the page beats
 * letting the user discover it in another product.
 */
export const endpointWarning = (url) => {
  if (/^https:\/\//i.test(url)) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url) || url.startsWith('/')) {
    return 'This is a local development URL. Claude requires a public https:// address '
      + 'for remote connectors, so this one cannot be pasted in. Use the local stdio '
      + 'server instead (see mcp/README.md), or deploy and connect to the hosted URL.';
  }
  return 'Claude requires an https:// address for remote connectors. This URL will be '
    + 'rejected until the server is served over HTTPS.';
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
