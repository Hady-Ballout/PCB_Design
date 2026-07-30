import { describe, expect, it } from 'vitest';
import { recordProviderUsage, trackTokenUsage, currentTrackedTokens } from './tokenUsage.js';

describe('trackTokenUsage + recordProviderUsage', () => {
  it('sums total_tokens from provider responses recorded during the scope', async () => {
    const { result, tokens } = await trackTokenUsage(async () => {
      recordProviderUsage({ usage: { total_tokens: 1200 } });
      recordProviderUsage({ usage: { total_tokens: 800 } });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(tokens).toBe(2000);
  });

  it('falls back to prompt_tokens + completion_tokens when total is absent', async () => {
    const { tokens } = await trackTokenUsage(async () => {
      recordProviderUsage({ usage: { prompt_tokens: 300, completion_tokens: 150 } });
    });
    expect(tokens).toBe(450);
  });

  it('ignores payloads without a usage object', async () => {
    const { tokens } = await trackTokenUsage(async () => {
      recordProviderUsage({ choices: [{ delta: { content: 'hi' } }] });
      recordProviderUsage(null);
      recordProviderUsage(undefined);
      recordProviderUsage({ usage: {} });
    });
    expect(tokens).toBe(0);
  });

  it('isolates concurrent scopes from each other', async () => {
    const [a, b] = await Promise.all([
      trackTokenUsage(async () => {
        recordProviderUsage({ usage: { total_tokens: 10 } });
        await new Promise((r) => setTimeout(r, 5));
        recordProviderUsage({ usage: { total_tokens: 10 } });
      }),
      trackTokenUsage(async () => {
        recordProviderUsage({ usage: { total_tokens: 100 } });
      }),
    ]);
    expect(a.tokens).toBe(20);
    expect(b.tokens).toBe(100);
  });

  it('is a safe no-op outside any tracking scope', () => {
    expect(() => recordProviderUsage({ usage: { total_tokens: 999 } })).not.toThrow();
    expect(currentTrackedTokens()).toBe(0);
  });
});
