import type { PostHog } from 'posthog-js';

type CanRegister = Pick<PostHog, 'register'>;

/**
 * The super-properties the marketing machine uses to assign a visit to Helm: the utm values
 * from the URL, the campaign defaulting to 'helm', product and platform (the same block
 * helm.mom registers). Called on load and again after posthog.reset(), which clears them.
 */
export function registerHelmAttribution(ph: CanRegister): void {
  const q = new URLSearchParams(window.location.search);
  ph.register({
    $utm_source: q.get('utm_source') || '',
    $utm_medium: q.get('utm_medium') || '',
    $utm_campaign: q.get('utm_campaign') || 'helm',
    $utm_content: q.get('utm_content') || '',
    $utm_term: q.get('utm_term') || '',
    product: 'helm',
    platform: 'web',
  });
}
