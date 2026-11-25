/** Helpers shared by the preview builders. */
import type { ApprovalRequest } from '@reins/shared';
import { credentialVault } from '../../credentials/vault.js';
import { credentialFor } from '../email-summary.js';

const LOOKUP_TIMEOUT_MS = 5000;

export type Args = Record<string, unknown>;

export const argsOf = (approval: ApprovalRequest): Args => (approval.arguments ?? {}) as Args;

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

/** A string or number argument as text. Ids arrive as either. */
export const idOf = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v);

export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];

export const plural = (count: number, one: string, many = `${one}s`): string =>
  count === 1 ? one : `${count} ${many}`;

/** "Nov 20, 2026" from anything Date can read; undefined otherwise. */
export function shortDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The agent's access token for a service, or null when it has none. */
export async function tokenFor(
  approval: ApprovalRequest,
  serviceType: string
): Promise<string | null> {
  try {
    return (await credentialFor(approval.agentId, serviceType, str(argsOf(approval).account)))?.token ?? null;
  } catch {
    return null;
  }
}

/** GET (or POST) JSON; null on any failure, so a lookup can never block an approval. */
export async function fetchJson<T>(
  url: string,
  init: { headers: Record<string, string>; method?: string; body?: string }
): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * The token plus the rest of the stored credential, for services whose API
 * address is part of it (a Zendesk subdomain, a Pipedrive company domain).
 */
export async function connectionFor(
  approval: ApprovalRequest,
  serviceType: string
): Promise<{ token: string; data: Record<string, unknown> } | null> {
  try {
    const credential = await credentialFor(approval.agentId, serviceType, str(argsOf(approval).account));
    if (!credential) return null;
    const stored = await credentialVault.retrieve(credential.credentialId);
    return { token: credential.token, data: (stored?.data ?? {}) as unknown as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** "expected_close_date" → "Expected close date". */
export function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Any argument value as one line of text. */
export function plain(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(plain).join(', ');
  return JSON.stringify(value);
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
