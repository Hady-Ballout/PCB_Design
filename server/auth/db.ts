import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import type { LocalUser, QueryResult } from '../types.js';

// Verify the database server's TLS certificate by default. A CA bundle can be
// supplied via PG_CA_CERT; verification is only relaxed when PG_SSL_NO_VERIFY=1
// is set explicitly (e.g. local development against a self-signed cert).
function sslConfig(): pg.PoolConfig['ssl'] {
  if (process.env.PG_SSL_NO_VERIFY === '1') return { rejectUnauthorized: false };
  if (process.env.PG_CA_CERT) return { ca: readFileSync(process.env.PG_CA_CERT, 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: true };
}

let pool: pg.Pool | undefined;
let localUsers: LocalUser[] = [];
let nextLocalUserId = 1;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
    });
  }
  return pool;
}

function localResult<T = Record<string, unknown>>(rows: T[] = []): QueryResult<T> {
  return { rows };
}

function seedLocalAdmin(): void {
  const email = String(process.env.LOCAL_ADMIN_EMAIL || 'admin@local.test').trim().toLowerCase();
  const password = String(process.env.LOCAL_ADMIN_PASSWORD || 'PcbPilotLocal!2026');

  nextLocalUserId = 1; // Re-seeding (e.g. tests) starts the store fresh.
  localUsers = [{
    id: nextLocalUserId++,
    email,
    password_hash: hashPassword(password),
    verified: true,
    verify_token: null,
    created_at: new Date().toISOString(),
    ...billingDefaults(),
  }];
}

function billingDefaults(): Pick<LocalUser, 'stripe_customer_id' | 'plan' | 'plan_status' | 'plan_period_end' | 'usage_generations' | 'usage_assists' | 'usage_month' | 'usage_tokens' | 'usage_day'> {
  return {
    stripe_customer_id: null,
    plan: 'free',
    plan_status: null,
    plan_period_end: null,
    usage_generations: 0,
    usage_assists: 0,
    usage_month: null,
    usage_tokens: 0,
    usage_day: null,
  };
}

export async function initDb(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    seedLocalAdmin();
    console.log('Local auth initialized without DATABASE_URL.');
    return;
  }

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      verified      BOOLEAN DEFAULT FALSE,
      verify_token  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Billing columns (Stripe subscription state + monthly usage meters).
  await getPool().query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
      ADD COLUMN IF NOT EXISTS plan               TEXT DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS plan_status        TEXT,
      ADD COLUMN IF NOT EXISTS plan_period_end    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS usage_generations  INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS usage_assists      INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS usage_month        TEXT,
      ADD COLUMN IF NOT EXISTS usage_tokens       INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS usage_day          TEXT;
  `);
  console.log('Database initialized.');
}

export function query(text: string, params: unknown[]): Promise<QueryResult> | QueryResult {
  if (process.env.DATABASE_URL) return getPool().query(text, params) as Promise<QueryResult>;

  const normalized = text.replace(/\s+/g, ' ').trim();

  if (normalized === 'SELECT id FROM users WHERE email = $1') {
    const email = String(params[0] || '').toLowerCase();
    return localResult(localUsers.filter((user) => user.email === email).map(({ id }) => ({ id })));
  }

  if (normalized === 'INSERT INTO users (email, password_hash, verify_token) VALUES ($1, $2, $3)') {
    const email = String(params[0] || '').toLowerCase();
    localUsers.push({
      id: nextLocalUserId++,
      email,
      password_hash: params[1] as string,
      verified: false,
      verify_token: params[2] as string,
      created_at: new Date().toISOString(),
      ...billingDefaults(),
    });
    return localResult([]);
  }

  if (normalized === 'DELETE FROM users WHERE email = $1') {
    const email = String(params[0] || '').toLowerCase();
    localUsers = localUsers.filter((user) => user.email !== email);
    return localResult([]);
  }

  if (normalized === 'SELECT id, email, password_hash, verified FROM users WHERE email = $1') {
    const email = String(params[0] || '').toLowerCase();
    return localResult(localUsers
      .filter((user) => user.email === email)
      .map(({ id, email: userEmail, password_hash, verified }) => ({
        id,
        email: userEmail,
        password_hash,
        verified,
      })));
  }

  if (normalized === 'SELECT id FROM users WHERE verify_token = $1') {
    return localResult(localUsers
      .filter((user) => user.verify_token === params[0])
      .map(({ id }) => ({ id })));
  }

  if (normalized === 'UPDATE users SET verified = TRUE, verify_token = NULL WHERE verify_token = $1') {
    localUsers = localUsers.map((user) => (
      user.verify_token === params[0]
        ? { ...user, verified: true, verify_token: null }
        : user
    ));
    return localResult([]);
  }

  if (normalized === 'SELECT id, email, created_at FROM users WHERE id = $1') {
    const id = Number(params[0]);
    return localResult(localUsers
      .filter((user) => user.id === id)
      .map(({ id: userId, email, created_at }) => ({ id: userId, email, created_at })));
  }

  // ── Billing queries (mirrored by server/billing/store.ts) ──

  if (normalized === 'SELECT id, plan, plan_status, plan_period_end, stripe_customer_id, usage_generations, usage_assists, usage_month, usage_tokens, usage_day FROM users WHERE id = $1') {
    const id = Number(params[0]);
    return localResult(localUsers
      .filter((user) => user.id === id)
      .map(({ id: userId, plan, plan_status, plan_period_end, stripe_customer_id, usage_generations, usage_assists, usage_month, usage_tokens, usage_day }) => ({
        id: userId, plan, plan_status, plan_period_end, stripe_customer_id, usage_generations, usage_assists, usage_month, usage_tokens, usage_day,
      })));
  }

  if (normalized === 'SELECT id FROM users WHERE stripe_customer_id = $1') {
    return localResult(localUsers
      .filter((user) => user.stripe_customer_id === params[0])
      .map(({ id }) => ({ id })));
  }

  if (normalized === 'UPDATE users SET stripe_customer_id = $2 WHERE id = $1') {
    const id = Number(params[0]);
    localUsers = localUsers.map((user) => (
      user.id === id ? { ...user, stripe_customer_id: params[1] as string } : user
    ));
    return localResult([]);
  }

  if (normalized === 'UPDATE users SET plan = $2, plan_status = $3, plan_period_end = $4 WHERE id = $1') {
    const id = Number(params[0]);
    localUsers = localUsers.map((user) => (
      user.id === id
        ? {
            ...user,
            plan: params[1] as string,
            plan_status: params[2] as string | null,
            plan_period_end: params[3] as string | null,
          }
        : user
    ));
    return localResult([]);
  }

  if (normalized === 'UPDATE users SET plan = $2, plan_status = $3, plan_period_end = $4, stripe_customer_id = $5 WHERE id = $1') {
    const id = Number(params[0]);
    localUsers = localUsers.map((user) => (
      user.id === id
        ? {
            ...user,
            plan: params[1] as string,
            plan_status: params[2] as string | null,
            plan_period_end: params[3] as string | null,
            stripe_customer_id: params[4] as string | null,
          }
        : user
    ));
    return localResult([]);
  }

  if (normalized === 'UPDATE users SET usage_generations = $2, usage_assists = $3, usage_month = $4 WHERE id = $1') {
    const id = Number(params[0]);
    localUsers = localUsers.map((user) => (
      user.id === id
        ? {
            ...user,
            usage_generations: Number(params[1]),
            usage_assists: Number(params[2]),
            usage_month: params[3] as string,
          }
        : user
    ));
    return localResult([]);
  }

  if (normalized === 'UPDATE users SET usage_tokens = $2, usage_day = $3 WHERE id = $1') {
    const id = Number(params[0]);
    localUsers = localUsers.map((user) => (
      user.id === id
        ? {
            ...user,
            usage_tokens: Number(params[1]),
            usage_day: params[2] as string,
          }
        : user
    ));
    return localResult([]);
  }

  throw new Error(`Unsupported local auth query: ${normalized}`);
}
