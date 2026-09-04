import nodemailer from 'nodemailer';
import { parseAllowedOrigins } from '../cors.js';

// Verification-email delivery. Two transports, chosen by environment:
//
//   1. Generic SMTP (SMTP_HOST + SMTP_USER + SMTP_PASS) — works with Gmail
//      (App Password), Resend, Brevo's SMTP relay, SES, etc. Preferred when
//      present because it needs no provider-specific account approval.
//   2. Brevo transactional API (BREVO_API_KEY) — the original path, kept as a
//      fallback for deployments that already have it.
//
// Signup treats a throw here as "the account cannot be verified" and rolls
// the user back, so failures must surface as exceptions, never be swallowed.

const DEFAULT_FROM_NAME = 'PCB Pilot';
const SUBJECT = 'Verify your PCB Pilot account';

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function isEmailConfigured(): boolean {
  return smtpConfigured() || Boolean(process.env.BREVO_API_KEY);
}

// Canonical frontend URL for the verify link. Prefer APP_URL — the same
// canonical origin billing uses for Stripe return URLs (e.g. https://impedo.ai)
// — then fall back to the first CORS_ORIGIN entry, then local dev. Getting
// this wrong points users at a dead domain and the verify link 404s.
function frontendUrl(): string {
  return (
    process.env.APP_URL
    || parseAllowedOrigins(process.env.CORS_ORIGIN)[0]
    || 'http://127.0.0.1:5174'
  ).replace(/\/$/, '');
}

export function verificationHtml(token: string): string {
  const verifyLink = `${frontendUrl()}/#verify?token=${token}`;
  return `
    <div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #23533a; margin-bottom: 8px;">Welcome to PCB Pilot</h2>
      <p style="color: #444; line-height: 1.6;">
        Click the button below to verify your email and activate your account.
      </p>
      <a href="${verifyLink}"
         style="display: inline-block; margin: 24px 0; padding: 12px 28px;
                background: #23533a; color: #fff; text-decoration: none;
                border-radius: 6px; font-weight: 600;">
        Verify Email
      </a>
      <p style="color: #888; font-size: 13px;">
        If you didn't create an account, you can ignore this email.
      </p>
    </div>
  `;
}

async function sendViaSmtp(to: string, html: string): Promise<void> {
  const host = process.env.SMTP_HOST as string;
  const user = process.env.SMTP_USER as string;
  const pass = process.env.SMTP_PASS as string;
  const port = Number(process.env.SMTP_PORT) || 587;
  // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Let SMTP_SECURE
  // override for providers that differ.
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : port === 465;

  const fromEmail = process.env.EMAIL_FROM || user;
  const fromName = process.env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME;

  const transport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  await transport.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: SUBJECT,
    html,
  });
}

async function sendViaBrevo(to: string, html: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY as string;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@pcbpilot.com';
  const senderName = process.env.BREVO_SENDER_NAME || DEFAULT_FROM_NAME;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      subject: SUBJECT,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Brevo error ${response.status}: ${err}`);
  }
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const html = verificationHtml(token);
  if (smtpConfigured()) return sendViaSmtp(to, html);
  if (process.env.BREVO_API_KEY) return sendViaBrevo(to, html);
  throw new Error('No email transport configured: set SMTP_HOST/SMTP_USER/SMTP_PASS or BREVO_API_KEY.');
}
