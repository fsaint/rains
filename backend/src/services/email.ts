import { config } from '../config/index.js';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const { mailgunApiKey, mailgunDomain, mailgunFrom } = config;

  if (!mailgunApiKey || !mailgunDomain) {
    console.warn('[email] Mailgun not configured — skipping email to', opts.to);
    return;
  }

  const from = mailgunFrom || `Reins <noreply@${mailgunDomain}>`;

  const body = new URLSearchParams({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });

  const res = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mailgun error ${res.status}: ${text}`);
  }
}

export async function sendReauthEmail(opts: {
  to: string;
  agentName: string;
  provider: string;
  hint: string;
  approvalId: string;
  dashboardUrl: string;
}): Promise<void> {
  const providerLabel: Record<string, string> = {
    'gmail': 'Gmail',
    'drive': 'Google Drive',
    'calendar': 'Google Calendar',
    'github': 'GitHub',
    'linear': 'Linear',
    'notion': 'Notion',
    'outlook-mail': 'Outlook Mail',
    'outlook-calendar': 'Outlook Calendar',
    'microsoft': 'Microsoft',
    'hermeneutix': 'Hermeneutix',
    'unknown': 'your service',
  };

  const label = providerLabel[opts.provider] ?? opts.provider;
  const approvalUrl = `${opts.dashboardUrl}/approvals?id=${opts.approvalId}`;

  const subject = `Action required: Re-authenticate ${label} for "${opts.agentName}"`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
  <div style="margin-bottom: 24px;">
    <span style="font-size: 20px; font-weight: 700; color: #1a1a2e;">Reins</span>
  </div>

  <h1 style="font-size: 18px; font-weight: 600; margin: 0 0 8px;">Authentication required</h1>
  <p style="color: #6b7280; margin: 0 0 24px; font-size: 14px;">
    Deployment of agent <strong>${opts.agentName}</strong> failed because ${label} credentials are invalid or expired.
  </p>

  <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 16px; margin-bottom: 24px;">
    <p style="margin: 0; font-size: 14px; color: #92400e;">${opts.hint}</p>
  </div>

  <a href="${approvalUrl}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; font-size: 14px; font-weight: 500; padding: 10px 20px; border-radius: 8px;">
    Re-authenticate now →
  </a>

  <p style="margin-top: 32px; font-size: 12px; color: #9ca3af;">
    This request will expire in 7 days. If you did not expect this email, you can ignore it.
  </p>
</body>
</html>`;

  const text = `Authentication required for agent "${opts.agentName}"\n\n${opts.hint}\n\nRe-authenticate here: ${approvalUrl}\n\nThis request expires in 7 days.`;

  await sendEmail({ to: opts.to, subject, html, text });
}

/** Shared shell so every Helm email looks like the same product. */
function wrap(title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#141413">
  <h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
  ${bodyHtml}
  <p style="color:#6b7280;font-size:12px;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:14px">Helm — the trust layer for AI agents</p>
</div>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${href}" style="background:#2563eb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;display:inline-block">${label}</a></p>`;
}

/**
 * Invite an admin-created user. They have no password — the account is reached
 * by signing in with Google using this address — so the link goes to the
 * dashboard, not to a password form.
 */
export async function sendInviteEmail(opts: {
  to: string;
  name: string;
  trialDays: number;
  trialEndsAt: string;
  dashboardUrl: string;
}): Promise<void> {
  const ends = new Date(opts.trialEndsAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const firstName = opts.name.trim().split(/\s+/)[0] || opts.name;

  const html = wrap(
    `You have been invited to Helm`,
    `<p>Hi ${firstName},</p>
     <p>An account has been created for you on Helm, with a <strong>${opts.trialDays}-day free trial</strong> running until <strong>${ends}</strong>.</p>
     <p>Sign in with Google using <strong>${opts.to}</strong> — there is no password to set.</p>
     ${button(opts.dashboardUrl, 'Open Helm')}
     <p>Once you are in, connect Telegram from the Notifications page. Helm asks you to approve anything an agent does on your behalf, and that is where the approvals arrive.</p>`
  );

  const text = [
    `Hi ${firstName},`,
    ``,
    `An account has been created for you on Helm, with a ${opts.trialDays}-day free trial running until ${ends}.`,
    `Sign in with Google using ${opts.to} — there is no password to set.`,
    ``,
    opts.dashboardUrl,
    ``,
    `Once you are in, connect Telegram from the Notifications page. Helm asks you to approve anything an agent does on your behalf, and that is where the approvals arrive.`,
  ].join('\n');

  await sendEmail({ to: opts.to, subject: `Your Helm account is ready (${opts.trialDays}-day trial)`, html, text });
}

/** Trial running out. Sent at 7 days and again at 1 day. */
export async function sendTrialReminderEmail(opts: {
  to: string;
  name: string;
  daysLeft: number;
  trialEndsAt: string;
  dashboardUrl: string;
}): Promise<void> {
  const firstName = opts.name.trim().split(/\s+/)[0] || opts.name;
  const when = opts.daysLeft === 1 ? 'tomorrow' : `in ${opts.daysLeft} days`;
  const pricingUrl = `${opts.dashboardUrl.replace(/\/+$/, '')}/pricing`;

  const html = wrap(
    `Your Helm trial ends ${when}`,
    `<p>Hi ${firstName},</p>
     <p>Your free trial ends <strong>${when}</strong>. After that your agents stop making tool calls until you pick a plan — your data, memory and settings stay exactly as they are.</p>
     ${button(pricingUrl, 'Choose a plan')}`
  );

  const text = [
    `Hi ${firstName},`,
    ``,
    `Your Helm free trial ends ${when}. After that your agents stop making tool calls until you pick a plan.`,
    `Your data, memory and settings stay exactly as they are.`,
    ``,
    pricingUrl,
  ].join('\n');

  await sendEmail({
    to: opts.to,
    subject: opts.daysLeft === 1 ? 'Your Helm trial ends tomorrow' : `Your Helm trial ends in ${opts.daysLeft} days`,
    html,
    text,
  });
}
