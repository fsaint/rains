/**
 * Agent Registration Service
 *
 * Handles agent self-registration with claim codes.
 * Flow:
 * 1. Agent calls register() -> gets claim code
 * 2. Agent displays code to user
 * 3. User enters code in dashboard -> calls claim()
 * 4. Agent polls status until claimed
 */

import { db, client } from '../db/index.js';
import { pendingAgentRegistrations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// Claim code format: 6 alphanumeric characters, easy to type
function generateClaimCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous: 0/O, 1/I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export interface PendingRegistration {
  id: string;
  name: string;
  description: string | null;
  claimCode: string;
  expiresAt: string;
  createdAt: string;
}

export interface RegisteredAgent {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
}

export interface RegistrationResult {
  agentId: string;
  claimCode: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * Register a new agent and get a claim code
 * Code expires in 10 minutes
 */
export async function registerAgent(
  name: string,
  description?: string
): Promise<RegistrationResult> {
  const id = nanoid();
  const claimCode = generateClaimCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.insert(pendingAgentRegistrations).values({
    id,
    name,
    description: description ?? null,
    claimCode,
    expiresAt: expiresAt.toISOString(),
  });

  return {
    agentId: id,
    claimCode,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: 600,
  };
}

/**
 * Get pending registration by claim code
 */
export async function getPendingByCode(code: string): Promise<PendingRegistration | null> {
  const upperCode = code.toUpperCase().trim();

  const [pending] = await db
    .select()
    .from(pendingAgentRegistrations)
    .where(eq(pendingAgentRegistrations.claimCode, upperCode));

  if (!pending) return null;

  // Check if expired
  if (new Date(pending.expiresAt) < new Date()) {
    // Clean up expired registration
    await db.delete(pendingAgentRegistrations).where(eq(pendingAgentRegistrations.id, pending.id));
    return null;
  }

  return pending;
}

/**
 * Claim an agent by code - moves from pending to active agents
 */
export async function claimAgent(code: string, userId?: string): Promise<RegisteredAgent | null> {
  const pending = await getPendingByCode(code);
  if (!pending) return null;

  const now = new Date().toISOString();

  // Create the actual agent
  await client.execute({
    sql: `INSERT INTO agents (id, user_id, name, description, policy_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`,
    args: [pending.id, userId ?? null, pending.name, pending.description, now, now],
  });

  // Remove from pending
  await db.delete(pendingAgentRegistrations).where(eq(pendingAgentRegistrations.id, pending.id));

  return {
    id: pending.id,
    name: pending.name,
    description: pending.description,
    status: 'active',
    createdAt: now,
  };
}

/**
 * Check registration status - returns 'pending', 'claimed', or 'expired'
 */
export async function getRegistrationStatus(
  agentId: string
): Promise<{ status: 'pending' | 'claimed' | 'expired' | 'not_found'; agent?: RegisteredAgent }> {
  // Check if already claimed (exists in agents table)
  const agentResult = await client.execute({
    sql: `SELECT * FROM agents WHERE id = ?`,
    args: [agentId],
  });

  if (agentResult.rows.length > 0) {
    const agent = agentResult.rows[0];
    return {
      status: 'claimed',
      agent: {
        id: agent.id as string,
        name: agent.name as string,
        description: agent.description as string | null,
        status: agent.status as string,
        createdAt: agent.created_at as string,
      },
    };
  }

  // Check if pending
  const [pending] = await db
    .select()
    .from(pendingAgentRegistrations)
    .where(eq(pendingAgentRegistrations.id, agentId));

  if (pending) {
    // Check if expired
    if (new Date(pending.expiresAt) < new Date()) {
      await db.delete(pendingAgentRegistrations).where(eq(pendingAgentRegistrations.id, agentId));
      return { status: 'expired' };
    }
    return { status: 'pending' };
  }

  return { status: 'not_found' };
}

/**
 * List all pending registrations (for admin view)
 */
export async function listPendingRegistrations(userId?: string): Promise<PendingRegistration[]> {
  const now = new Date().toISOString();

  // Clean up expired registrations
  await client.execute({
    sql: `DELETE FROM pending_agent_registrations WHERE expires_at < ?`,
    args: [now],
  });

  if (userId) {
    return db.select().from(pendingAgentRegistrations)
      .where(eq(pendingAgentRegistrations.userId, userId));
  }
  return db.select().from(pendingAgentRegistrations);
}

/**
 * Cancel a pending registration
 */
export async function cancelRegistration(agentId: string): Promise<boolean> {
  const result = await db
    .delete(pendingAgentRegistrations)
    .where(eq(pendingAgentRegistrations.id, agentId));

  return (result as any).rowsAffected > 0 || (result as any).length > 0;
}
