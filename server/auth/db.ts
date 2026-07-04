import pg from 'pg';
import { randomBytes, scryptSync } from 'node:crypto';
import type { LocalUser, QueryResult } from '../types.js';

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
      ssl: { rejectUnauthorized: false },
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

  localUsers = [{
    id: nextLocalUserId++,
    email,
    password_hash: hashPassword(password),
    verified: true,
    verify_token: null,
    created_at: new Date().toISOString(),
  }];
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
    });
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

  throw new Error(`Unsupported local auth query: ${normalized}`);
}
