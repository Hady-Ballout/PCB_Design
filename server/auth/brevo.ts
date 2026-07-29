import { parseAllowedOrigins } from '../cors.js';

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY is not set.');

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@pcbpilot.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'PCB Pilot';
  // Canonical frontend URL for the verify link. Prefer APP_URL — the same
  // canonical origin billing uses for Stripe return URLs (e.g. https://impedo.ai)
  // — then fall back to the first CORS_ORIGIN entry, then local dev. Getting
  // this wrong points users at a dead domain and the verify link 404s.
  const frontendUrl = (
    process.env.APP_URL
    || parseAllowedOrigins(process.env.CORS_ORIGIN)[0]
    || 'http://127.0.0.1:5174'
  ).replace(/\/$/, '');
  const verifyLink = `${frontendUrl}/#verify?token=${token}`;

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
      subject: 'Verify your PCB Pilot account',
      htmlContent: `
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
      `,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Brevo error ${response.status}: ${err}`);
  }
}
