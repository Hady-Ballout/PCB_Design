// Where a tool's bulky output goes.
//
// The six tools produce the same bytes regardless of transport, but a location
// only means something in context: a filesystem path is useful to someone running
// the server locally and meaningless to a remote user on Render. The sink is the
// seam — tools hand it content and get back a reference they can quote.

import { randomBytes } from 'node:crypto';
import { writeArtifact } from './artifacts.js';

export interface ArtifactRef {
  /** A filesystem path, or a URL path the caller can GET. */
  location: string;
  kind: 'file' | 'url';
}

/** Text for netlists and schematics, bytes for the zipped Gerber package. */
export type ArtifactContent = string | Uint8Array;

export interface ArtifactSink {
  put(filename: string, content: ArtifactContent): ArtifactRef;
}

/** Local/stdio sink: writes into an artifact directory on disk. */
export const fileSink = (dir: string): ArtifactSink => ({
  put: (filename, content) => ({
    kind: 'file',
    location: writeArtifact(dir, filename, content),
  }),
});

interface StoredArtifact {
  filename: string;
  content: ArtifactContent;
  subject: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * The stored name is echoed in a `Content-Disposition` header, so strip anything
 * that could break out of the quoted string or the header itself. Filenames here
 * are tool-generated rather than user-supplied, but the header is the wrong place
 * to rely on that.
 */
const safeDownloadName = (filename: string): string => {
  const cleaned = String(filename)
    .replace(/[\r\n"\\]/g, '')
    .split(/[/\\]/)
    .pop() ?? '';
  return cleaned.trim() || 'artifact';
};

/**
 * Hosted sink backing store: artifacts live in memory for a short window and are
 * fetched over HTTP.
 *
 * In-memory is a deliberate choice, not a shortcut. Artifacts are cheap to
 * regenerate, so a miss after a Render instance recycles costs the user one
 * re-run — whereas persisting user circuit geometry to disk or a bucket would
 * add a data-retention surface for no benefit. Nothing here is written to the
 * container filesystem.
 */
export class ArtifactStore {
  #entries = new Map<string, StoredArtifact>();

  #ttlMs: number;

  #now: () => number;

  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** A sink scoped to one authenticated subject; only they can read it back. */
  sinkFor(subject: string): ArtifactSink {
    return {
      put: (filename, content) => {
        this.#prune();
        const id = randomBytes(18).toString('base64url');
        this.#entries.set(id, {
          filename: safeDownloadName(filename),
          content,
          subject,
          expiresAt: this.#now() + this.#ttlMs,
        });
        return { kind: 'url', location: `/api/mcp/artifacts/${id}` };
      },
    };
  }

  get(id: string, subject: string): { filename: string; content: ArtifactContent } | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(id);
      return undefined;
    }
    // A wrong subject is indistinguishable from a wrong id to the caller: both
    // return undefined and the route answers 404, so ids can't be probed.
    if (entry.subject !== subject) return undefined;
    return { filename: entry.filename, content: entry.content };
  }

  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(id);
    }
  }
}
