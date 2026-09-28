/**
 * The welcome email for a Google self-enrollment (reins spec 2026-09-16 §2.6):
 * greeting, trial end date, where to set up the first agent, the pricing page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: { mailgunApiKey: 'key', mailgunDomain: 'mg.helm.mom', mailgunFrom: 'Helm <hi@helm.mom>' },
}));

import { sendWelcomeEmail } from './email.js';

let sent: URLSearchParams | undefined;

beforeEach(() => {
  sent = undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent = new URLSearchParams(String(init.body));
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const base = {
  to: 'ana@acme.com',
  firstName: 'Ana',
  trialDays: 15,
  trialEndsAt: '2026-10-13T12:00:00.000Z',
  dashboardUrl: 'https://app.helm.mom/',
};

describe('sendWelcomeEmail', () => {
  it('greets by first name with the trial length and end date', async () => {
    await sendWelcomeEmail(base);

    expect(sent!.get('to')).toBe('ana@acme.com');
    expect(sent!.get('subject')).toContain('15-day trial');
    const text = sent!.get('text')!;
    expect(text).toContain('Hi Ana,');
    expect(text).toContain('October 13, 2026');
    expect(sent!.get('html')).toContain('October 13, 2026');
  });

  it('links the agent setup page and the pricing page', async () => {
    await sendWelcomeEmail(base);

    for (const body of [sent!.get('text')!, sent!.get('html')!]) {
      expect(body).toContain('https://app.helm.mom/agents/new');
      expect(body).toContain('https://app.helm.mom/pricing');
      expect(body).not.toContain('helm.mom//');
    }
  });

  it('escapes a Google profile name in the HTML', async () => {
    await sendWelcomeEmail({ ...base, firstName: '<script>x</script>' });

    expect(sent!.get('html')).not.toContain('<script>');
    expect(sent!.get('html')).toContain('&lt;script&gt;');
  });

  it('greets without a name when there is none', async () => {
    await sendWelcomeEmail({ ...base, firstName: '' });

    expect(sent!.get('text')!.startsWith('Hi,')).toBe(true);
  });
});
