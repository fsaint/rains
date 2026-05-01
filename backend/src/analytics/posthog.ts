import { PostHog } from 'posthog-node';
import { config } from '../config/index.js';

let client: PostHog | null = null;

export function getPostHog(): PostHog | null {
  if (!config.posthogApiKey) return null;
  if (!client) {
    client = new PostHog(config.posthogApiKey, {
      host: config.posthogHost,
      flushAt: 20,
      flushInterval: 10000,
    });
  }
  return client;
}

export async function shutdownPostHog(): Promise<void> {
  await client?.shutdown();
}
