/**
 * Pending OAuth Flows Storage
 *
 * In-memory storage for OAuth state tokens with 10-minute TTL.
 * Used to prevent CSRF attacks during OAuth flow.
 */

interface PendingOAuthFlow {
  service: string;
  initiatedAt: Date;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const pendingFlows = new Map<string, PendingOAuthFlow>();

/**
 * Store a pending OAuth flow
 */
export function storePendingOAuthFlow(
  state: string,
  flow: { service: string }
): void {
  pendingFlows.set(state, {
    service: flow.service,
    initiatedAt: new Date(),
  });

  // Schedule cleanup after TTL
  setTimeout(() => {
    pendingFlows.delete(state);
  }, TTL_MS);
}

/**
 * Get a pending OAuth flow by state token
 */
export function getPendingOAuthFlow(state: string): PendingOAuthFlow | undefined {
  const flow = pendingFlows.get(state);
  if (!flow) return undefined;

  // Check if flow has expired
  const now = new Date();
  if (now.getTime() - flow.initiatedAt.getTime() > TTL_MS) {
    pendingFlows.delete(state);
    return undefined;
  }

  return flow;
}

/**
 * Delete a pending OAuth flow
 */
export function deletePendingOAuthFlow(state: string): boolean {
  return pendingFlows.delete(state);
}

/**
 * Clean up expired flows (for manual cleanup if needed)
 */
export function cleanupExpiredFlows(): number {
  const now = new Date();
  let cleaned = 0;

  // Use Array.from for compatibility
  const entries = Array.from(pendingFlows.entries());
  for (const [state, flow] of entries) {
    if (now.getTime() - flow.initiatedAt.getTime() > TTL_MS) {
      pendingFlows.delete(state);
      cleaned++;
    }
  }

  return cleaned;
}
