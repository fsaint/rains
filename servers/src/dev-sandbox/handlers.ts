/**
 * Dev Sandbox handlers — all synthetic, no real API calls.
 *
 * Every handler returns fake data after a short simulated delay so the
 * approval flow can be exercised end-to-end without any real credentials.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In-memory item store for the lifetime of the server process
const items: Record<string, { id: string; name: string; value: string; createdAt: string }> = {
  'item-1': { id: 'item-1', name: 'Alpha',   value: 'First item',  createdAt: '2026-01-01T00:00:00Z' },
  'item-2': { id: 'item-2', name: 'Beta',    value: 'Second item', createdAt: '2026-01-02T00:00:00Z' },
  'item-3': { id: 'item-3', name: 'Gamma',   value: 'Third item',  createdAt: '2026-01-03T00:00:00Z' },
};

// ── Read tools (always allow) ──────────────────────────────────────────────

export async function handleEcho(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(50);
  const message = String(args.message ?? '(empty)');
  return {
    success: true,
    data: {
      echo: message,
      timestamp: new Date().toISOString(),
      note: 'Dev sandbox echo — no real API involved',
    },
  };
}

export async function handleListItems(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(100);
  const limit = Math.min(Number(args.limit ?? 10), 50);
  const all = Object.values(items).slice(0, limit);
  return {
    success: true,
    data: { items: all, total: all.length },
  };
}

export async function handleGetItem(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(80);
  const id = String(args.id ?? '');
  const item = items[id];
  if (!item) {
    return { success: false, error: `Item not found: ${id}` };
  }
  return { success: true, data: item };
}

// ── Write tools (require_approval) ────────────────────────────────────────

export async function handleCreateItem(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(150);
  const id = `item-${Date.now()}`;
  const item = {
    id,
    name:      String(args.name ?? 'Untitled'),
    value:     String(args.value ?? ''),
    createdAt: new Date().toISOString(),
  };
  items[id] = item;
  return {
    success: true,
    data: { created: item, message: `Item "${item.name}" created successfully` },
  };
}

export async function handleSendMessage(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(200);
  return {
    success: true,
    data: {
      messageId: `msg-${Date.now()}`,
      to:        String(args.to ?? 'unknown'),
      subject:   String(args.subject ?? '(no subject)'),
      status:    'delivered',
      note:      'Dev sandbox — message was not actually sent anywhere',
    },
  };
}

export async function handleUpdateItem(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  await delay(120);
  const id = String(args.id ?? '');
  const item = items[id];
  if (!item) {
    return { success: false, error: `Item not found: ${id}` };
  }
  if (args.name  !== undefined) item.name  = String(args.name);
  if (args.value !== undefined) item.value = String(args.value);
  return {
    success: true,
    data: { updated: item, message: `Item "${id}" updated successfully` },
  };
}

// ── Blocked tools (always denied) ─────────────────────────────────────────
// These handlers can never be called through the normal path (policy blocks
// them before the tool fires), but are provided for completeness.

export async function handleDeleteItem(
  _args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  return { success: false, error: 'This tool is blocked by default policy' };
}

export async function handleWipeAll(
  _args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  return { success: false, error: 'This tool is blocked by default policy' };
}
