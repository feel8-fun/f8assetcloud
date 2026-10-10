import { HttpError, escapeHtml } from '../common/http.js';
import { toBoolean } from '../utils.js';

export function buildVerifyEmailUrl({ env, baseURL, token }) {
  const configuredBaseUrl = String(env.AUTH_VERIFY_EMAIL_BASE_URL || '').trim();
  const base = configuredBaseUrl
    ? new URL(configuredBaseUrl)
    : new URL('/verify-email', baseURL);
  base.searchParams.set('token', token);
  return base.toString();
}

export function buildResetPasswordUrl({ env, baseURL, token }) {
  const configuredBaseUrl = String(env.AUTH_RESET_PASSWORD_BASE_URL || '').trim();
  const base = configuredBaseUrl
    ? new URL(configuredBaseUrl)
    : new URL('/reset-password', baseURL);
  base.searchParams.set('token', token);
  return base.toString();
}

export function resolveAuthActionUrl({ preferredUrl, fallbackUrl }) {
  const candidate = String(preferredUrl || '').trim();
  if (candidate) {
    return candidate;
  }
  return String(fallbackUrl || '').trim();
}

export async function sendVerifyEmailMessage({ env, toEmail, recipientName, verificationUrl }) {
  await sendAuthEmail({
    env,
    debugLabel: 'verify email',
    debugUrl: verificationUrl,
    toEmail,
    subject: 'Verify your email',
    text: `Hi ${recipientName}, verify your email: ${verificationUrl}`,
    html: `<p>Hi ${escapeHtml(recipientName)},</p><p>Please verify your email:</p><p><a href="${escapeHtml(verificationUrl)}">${escapeHtml(verificationUrl)}</a></p>`,
  });
}

export async function sendResetPasswordMessage({ env, toEmail, recipientName, resetUrl }) {
  await sendAuthEmail({
    env,
    debugLabel: 'reset password',
    debugUrl: resetUrl,
    toEmail,
    subject: 'Reset your password',
    text: `Hi ${recipientName}, reset your password: ${resetUrl}`,
    html: `<p>Hi ${escapeHtml(recipientName)},</p><p>Use this link to reset password:</p><p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>`,
  });
}

async function sendAuthEmail({ env, debugLabel, debugUrl, toEmail, subject, text, html }) {
  const resendApiKey = String(env.RESEND_API_KEY || '').trim();
  const fromEmail = String(env.AUTH_EMAIL_FROM || '').trim();
  if (!resendApiKey || !fromEmail) {
    if (toBoolean(env.EXPOSE_DEBUG_AUTH_LINKS)) {
      console.info(`[auth debug] ${debugLabel}: ${debugUrl}`);
    } else {
      console.warn(`[auth] email delivery skipped (RESEND_API_KEY / AUTH_EMAIL_FROM not configured): ${debugLabel}`);
    }
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(502, `failed to send auth email: ${response.status} ${body}`);
  }
}
