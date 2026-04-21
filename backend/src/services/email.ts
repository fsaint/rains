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
    'anthropic': 'Anthropic Claude',
    'openai-codex': 'OpenAI',
    'openai': 'OpenAI',
    'minimax': 'MiniMax',
    'fly': 'Fly.io',
    'docker': 'Docker',
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
