import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { query } from './db.js';
import { sendVerificationEmail } from './brevo.js';
import type { AuthResult, JwtPayload } from '../types.js';

// ── Password hashing (scrypt, no extra deps) ──

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const buf = Buffer.from(hash, 'hex');
  const attempt = scryptSync(password, salt, 64);
  return buf.length === attempt.length && timingSafeEqual(buf, attempt);
}

// A throwaway hash used to spend the same scrypt time on a login miss as on a
// hit, so response latency does not reveal whether an email is registered.
const DUMMY_PASSWORD_HASH = hashPassword('password-enumeration-guard');

// ── JWT (minimal, no dependency) ──

function base64url(data: string | Record<string, unknown>): string {
  return Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64url');
}

function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');

  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const body = base64url({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set.');

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length || !timingSafeEqual(signatureBuf, expectedBuf)) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ── Route handlers ──

export async function handleSignup(body: Record<string, unknown>): Promise<AuthResult> {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) return { status: 400, body: { error: 'Email and password are required.' } };
  if (password.length < 8) return { status: 400, body: { error: 'Password must be at least 8 characters.' } };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Invalid email address.' } };

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) return { status: 409, body: { error: 'Email already registered.' } };

  const passwordHash = hashPassword(password);
  const verifyToken = randomBytes(32).toString('hex');

  await query(
    'INSERT INTO users (email, password_hash, verify_token) VALUES ($1, $2, $3)',
    [email, passwordHash, verifyToken]
  );

  try {
    await sendVerificationEmail(email, verifyToken);
  } catch (err) {
    console.error('Failed to send verification email:', (err as Error).message);
  }

  return { status: 201, body: { message: 'Account created. Check your email to verify.' } };
}

export async function handleLogin(body: Record<string, unknown>): Promise<AuthResult> {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) return { status: 400, body: { error: 'Email and password are required.' } };

  const result = await query('SELECT id, email, password_hash, verified FROM users WHERE email = $1', [email]);
  if (result.rows.length === 0) {
    verifyPassword(password, DUMMY_PASSWORD_HASH);
    return { status: 401, body: { error: 'Invalid email or password.' } };
  }

  const user = result.rows[0] as { id: number; email: string; password_hash: string; verified: boolean };
  if (!verifyPassword(password, user.password_hash)) return { status: 401, body: { error: 'Invalid email or password.' } };
  if (!user.verified) return { status: 403, body: { error: 'Please verify your email before logging in.' } };

  const token = signJwt({ id: user.id, email: user.email });
  return { status: 200, body: { token, user: { id: user.id, email: user.email } } };
}

export async function handleVerifyEmail(tokenValue: string | undefined): Promise<AuthResult> {
  if (!tokenValue) return { status: 400, body: { error: 'Verification token is required.' } };

  const result = await query('SELECT id FROM users WHERE verify_token = $1', [tokenValue]);
  if (result.rows.length === 0) return { status: 400, body: { error: 'Invalid or expired verification token.' } };

  await query('UPDATE users SET verified = TRUE, verify_token = NULL WHERE verify_token = $1', [tokenValue]);
  return { status: 200, body: { message: 'Email verified. You can now log in.' } };
}

export async function handleMe(request: IncomingMessage): Promise<AuthResult> {
  const auth = request.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { status: 401, body: { error: 'Not authenticated.' } };

  const payload = verifyJwt(token);
  if (!payload) return { status: 401, body: { error: 'Invalid or expired token.' } };

  const result = await query('SELECT id, email, created_at FROM users WHERE id = $1', [payload.id]);
  if (result.rows.length === 0) return { status: 401, body: { error: 'User not found.' } };

  return { status: 200, body: { user: result.rows[0] } };
}
