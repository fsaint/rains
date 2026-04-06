import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, auth, agents, approvals, credentials } from './client';

// ─── ApiError ────────────────────────────────────────────────────────────────

describe('ApiError', () => {
  it('creates error with code and message', () => {
    const err = new ApiError('NOT_FOUND', 'Resource not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Resource not found');
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts optional details', () => {
    const details = { field: 'email', reason: 'invalid' };
    const err = new ApiError('VALIDATION', 'Validation error', details);
    expect(err.details).toEqual(details);
  });

  it('has undefined details when not provided', () => {
    const err = new ApiError('CODE', 'msg');
    expect(err.details).toBeUndefined();
  });
});

// ─── request() behaviour via public API ──────────────────────────────────────

describe('API request', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(status: number, body: unknown, ok = status < 400) {
    vi.mocked(fetch).mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it('returns data.data when present', async () => {
    mockFetch(200, { data: { authenticated: true, user: { id: 'u1', email: 'a@b.com', name: 'A', role: 'admin' } } });
    const result = await auth.session();
    expect((result as any).authenticated).toBe(true);
  });

  it('returns raw body when no data wrapper', async () => {
    mockFetch(200, { authenticated: true, user: { id: 'u1', email: 'x@y.com', name: 'X', role: 'user' } });
    const result = await auth.session();
    expect((result as any).authenticated).toBe(true);
  });

  it('throws ApiError on 4xx response', async () => {
    mockFetch(401, { error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, false);
    await expect(auth.session()).rejects.toThrow(ApiError);
  });

  it('throws ApiError with correct code from response body', async () => {
    mockFetch(404, { error: { code: 'NOT_FOUND', message: 'Agent not found' } }, false);
    try {
      await agents.get('missing');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('NOT_FOUND');
      expect((err as ApiError).message).toBe('Agent not found');
    }
  });

  it('falls back to UNKNOWN code when error body is unreadable', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse error')),
    } as unknown as Response);

    await expect(auth.session()).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('returns undefined for 204 No Content', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    } as Response);

    const result = await agents.delete('a1');
    expect(result).toBeUndefined();
  });

  it('sets Content-Type: application/json when body is present', async () => {
    mockFetch(200, { data: { authenticated: true, user: null } });
    await auth.login('a@b.com', 'pw');
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect((options?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('does not set Content-Type for GET requests', async () => {
    mockFetch(200, []);
    await agents.list();
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect((options?.headers as Record<string, string>)?.['Content-Type']).toBeUndefined();
  });
});

// ─── auth namespace ───────────────────────────────────────────────────────────

describe('auth.login', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts credentials to /api/auth/login', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { authenticated: true, user: { id: 'u1', email: 'a@b.com', name: 'A', role: 'user' } } }),
    } as Response);

    await auth.login('a@b.com', 'secret');

    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(options?.body as string)).toEqual({ email: 'a@b.com', password: 'secret' });
  });
});

// ─── approvals namespace ──────────────────────────────────────────────────────

describe('approvals', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list() fetches /api/approvals', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) } as Response);
    await approvals.list();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/approvals');
  });

  it('approve() posts to /api/approvals/:id/approve', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    await approvals.approve('appr-1');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/approvals/appr-1/approve');
    expect(options?.method).toBe('POST');
  });

  it('reject() posts to /api/approvals/:id/reject with reason', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    await approvals.reject('appr-1', 'Not authorized');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/approvals/appr-1/reject');
    expect(JSON.parse(options?.body as string)).toEqual({ reason: 'Not authorized' });
  });
});

// ─── credentials namespace ────────────────────────────────────────────────────

describe('credentials', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delete() sends DELETE to /api/credentials/:id', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve(null) } as Response);
    await credentials.delete('cred-1');
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/credentials/cred-1');
    expect(options?.method).toBe('DELETE');
  });
});
