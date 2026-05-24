import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn() },
}));

vi.mock('../config/index.js', () => ({
  config: { sharedBotToken: 'test-token', dashboardUrl: 'https://test.example.com' },
}));

import { client } from '../db/index.js';
import {
  estimateCost,
  currentBillingPeriod,
  getPeriodSpend,
  checkSpendCap,
} from './spend.js';

const mockExecute = vi.mocked(client.execute);

beforeEach(() => {
  vi.clearAllMocks();
  // Suppress fetch calls in notifiers
  global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe('estimateCost', () => {
  it('uses model-specific pricing when modelName matches', () => {
    // MiniMax: $0.80/1M input, $1.60/1M output
    const cost = estimateCost(1_000_000, 1_000_000, 'minimax', 'minimax-m2.7');
    expect(cost).toBeCloseTo(0.80 + 1.60);
  });

  it('falls back to provider pricing when modelName is unknown', () => {
    const cost = estimateCost(1_000_000, 0, 'anthropic', 'claude-future-model');
    expect(cost).toBeCloseTo(3.00);
  });

  it('falls back to default Sonnet pricing when provider is unknown', () => {
    const cost = estimateCost(1_000_000, 1_000_000, null, null);
    expect(cost).toBeCloseTo(3.00 + 15.00);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost(0, 0, 'anthropic', 'claude-sonnet-4-6')).toBe(0);
  });

  it('OpenAI is cheaper than Anthropic Sonnet for same volume', () => {
    const openai   = estimateCost(1_000_000, 1_000_000, 'openai', 'gpt-4o');
    const anthropic = estimateCost(1_000_000, 1_000_000, 'anthropic', 'claude-sonnet-4-6');
    expect(openai).toBeLessThan(anthropic);
  });
});

// ---------------------------------------------------------------------------
// currentBillingPeriod
// ---------------------------------------------------------------------------

describe('currentBillingPeriod', () => {
  it('returns YYYY-MM format', () => {
    expect(currentBillingPeriod()).toMatch(/^\d{4}-\d{2}$/);
  });

  it('matches the current UTC month', () => {
    const now = new Date();
    const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(currentBillingPeriod()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getPeriodSpend
// ---------------------------------------------------------------------------

describe('getPeriodSpend', () => {
  it('returns aggregated spend for current period', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ total_dollars: 12.5, total_input: 5_000_000, total_output: 2_000_000 }],
      rowsAffected: 0,
      columns: [],
      lastInsertRowid: 0n,
    } as any);

    const spend = await getPeriodSpend(client, 'agent-1');
    expect(spend.totalDollars).toBe(12.5);
    expect(spend.totalInputTokens).toBe(5_000_000);
    expect(spend.totalOutputTokens).toBe(2_000_000);
  });

  it('returns zeros when no records exist', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ total_dollars: 0, total_input: 0, total_output: 0 }],
      rowsAffected: 0,
      columns: [],
      lastInsertRowid: 0n,
    } as any);

    const spend = await getPeriodSpend(client, 'agent-2');
    expect(spend.totalDollars).toBe(0);
    expect(spend.totalInputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkSpendCap
// ---------------------------------------------------------------------------

describe('checkSpendCap', () => {
  function mockDeployment(overrides: Record<string, unknown>) {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        spend_limit_dollars:  null,
        spend_limit_tokens:   null,
        spend_soft_stopped:   0,
        spend_alerted_80:     0,
        ...overrides,
      }],
      rowsAffected: 0, columns: [], lastInsertRowid: 0n,
    } as any);
  }

  function mockSpend(dollars: number, input: number, output: number) {
    mockExecute.mockResolvedValueOnce({
      rows: [{ total_dollars: dollars, total_input: input, total_output: output }],
      rowsAffected: 0, columns: [], lastInsertRowid: 0n,
    } as any);
  }

  it('allows when no caps configured', async () => {
    mockDeployment({});
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBe(0);
  });

  it('allows when deployment not found', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [], rowsAffected: 0, columns: [], lastInsertRowid: 0n } as any);
    const result = await checkSpendCap(client, 'agent-x');
    expect(result.allowed).toBe(true);
  });

  it('allows at 50% token usage', async () => {
    mockDeployment({ spend_limit_tokens: 10_000_000 });
    mockSpend(0, 2_000_000, 3_000_000); // 5M of 10M = 50%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBeCloseTo(50);
    expect(result.shouldAlert80).toBe(false);
    expect(result.shouldSoftStop).toBe(false);
  });

  it('triggers 80% alert when token usage crosses threshold', async () => {
    mockDeployment({ spend_limit_tokens: 10_000_000, spend_alerted_80: 0 });
    mockSpend(0, 5_000_000, 4_000_000); // 9M of 10M = 90%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(true);
    expect(result.shouldAlert80).toBe(true);
    expect(result.shouldSoftStop).toBe(false);
  });

  it('does not re-alert 80% if already alerted', async () => {
    mockDeployment({ spend_limit_tokens: 10_000_000, spend_alerted_80: 1 });
    mockSpend(0, 5_000_000, 4_000_000); // 90%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.shouldAlert80).toBe(false);
  });

  it('soft-stops at 100% token usage', async () => {
    mockDeployment({ spend_limit_tokens: 10_000_000, spend_soft_stopped: 0 });
    mockSpend(0, 6_000_000, 5_000_000); // 11M of 10M = 110%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(false);
    expect(result.shouldSoftStop).toBe(true);
  });

  it('blocks when already soft-stopped even if under cap', async () => {
    mockDeployment({ spend_limit_tokens: 10_000_000, spend_soft_stopped: 1 });
    mockSpend(0, 1_000_000, 500_000); // 15% — under cap
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(false);
    expect(result.shouldSoftStop).toBe(false); // already stopped, don't re-trigger
  });

  it('uses dollar cap when token cap not set', async () => {
    mockDeployment({ spend_limit_dollars: 20.00, spend_limit_tokens: null });
    mockSpend(18.00, 0, 0); // $18 of $20 = 90%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.allowed).toBe(true);
    expect(result.percentUsed).toBeCloseTo(90);
    expect(result.shouldAlert80).toBe(true);
  });

  it('prefers token cap over dollar cap when both set', async () => {
    // Token cap at 50%, dollar cap would be at 90% — token cap wins
    mockDeployment({ spend_limit_tokens: 10_000_000, spend_limit_dollars: 20.00 });
    mockSpend(18.00, 2_500_000, 2_500_000); // 5M tokens = 50%, $18 = 90%
    const result = await checkSpendCap(client, 'agent-1');
    expect(result.percentUsed).toBeCloseTo(50);
  });
});
