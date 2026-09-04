import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, query } from './db.js';
import { handleSignup } from './auth.js';

// All tests run against the in-memory dev store (no DATABASE_URL). With no
// SMTP or Brevo settings the mailer throws before any network call, which is exactly
// the misconfiguration a fresh deployment hits.
beforeEach(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;
  await initDb();
});

describe('handleSignup when the verification email cannot be sent', () => {
  it('does not claim success', async () => {
    const result = await handleSignup({ email: 'new@example.com', password: 'longenough1' });
    expect(result.status).toBe(503);
    expect(String(result.body.error)).toMatch(/verification email/i);
  });

  it('rolls the account back so the user can retry once email is configured', async () => {
    await handleSignup({ email: 'new@example.com', password: 'longenough1' });
    const rows = await query('SELECT id FROM users WHERE email = $1', ['new@example.com']);
    expect(rows.rows).toHaveLength(0);
  });
});
