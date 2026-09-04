import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { isEmailConfigured, sendVerificationEmail, verificationHtml } from './mailer.js';

const EMAIL_VARS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE',
  'EMAIL_FROM', 'EMAIL_FROM_NAME',
  'BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME',
  'APP_URL', 'CORS_ORIGIN',
];

beforeEach(() => {
  for (const key of EMAIL_VARS) delete process.env[key];
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: 'x' });
  createTransport.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEmailConfigured', () => {
  it('is false with no mailer settings', () => {
    expect(isEmailConfigured()).toBe(false);
  });

  it('is true with a complete SMTP configuration', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'me@gmail.com';
    process.env.SMTP_PASS = 'app-password';
    expect(isEmailConfigured()).toBe(true);
  });

  it('is false when SMTP is only partially set', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'me@gmail.com';
    expect(isEmailConfigured()).toBe(false);
  });

  it('is true with a Brevo API key', () => {
    process.env.BREVO_API_KEY = 'xkeysib-test';
    expect(isEmailConfigured()).toBe(true);
  });
});

describe('verificationHtml', () => {
  it('links to APP_URL with the token in the hash route', () => {
    process.env.APP_URL = 'https://festo-ai.web.app/';
    expect(verificationHtml('tok123')).toContain('href="https://festo-ai.web.app/#verify?token=tok123"');
  });
});

describe('sendVerificationEmail over SMTP', () => {
  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'me@gmail.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.APP_URL = 'https://festo-ai.web.app';
  });

  it('builds a Gmail-style transport with sensible defaults', async () => {
    await sendVerificationEmail('user@example.com', 'tok');
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: 'me@gmail.com', pass: 'app-password' },
    });
  });

  it('sends from the SMTP user by default, honouring EMAIL_FROM when set', async () => {
    await sendVerificationEmail('user@example.com', 'tok');
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({
      from: '"PCB Pilot" <me@gmail.com>',
      to: 'user@example.com',
    }));

    process.env.EMAIL_FROM = 'hello@festo.ai';
    process.env.EMAIL_FROM_NAME = 'Festo AI';
    await sendVerificationEmail('user@example.com', 'tok');
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({
      from: '"Festo AI" <hello@festo.ai>',
    }));
  });

  it('respects SMTP_PORT and SMTP_SECURE', async () => {
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = '1';
    await sendVerificationEmail('user@example.com', 'tok');
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });

  it('prefers SMTP over Brevo when both are set', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await sendVerificationEmail('user@example.com', 'tok');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendVerificationEmail via Brevo', () => {
  it('posts to the Brevo API when only BREVO_API_KEY is set', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-test';
    process.env.BREVO_SENDER_EMAIL = 'noreply@festo.ai';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await sendVerificationEmail('user@example.com', 'tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(JSON.parse(String(init.body)).sender.email).toBe('noreply@festo.ai');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('throws a clear error when nothing is configured', async () => {
    await expect(sendVerificationEmail('user@example.com', 'tok')).rejects.toThrow(/SMTP_HOST.*BREVO_API_KEY/);
  });
});
