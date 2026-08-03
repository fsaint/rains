import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dnsLookup = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => dnsLookup(...args) }));

const httpsRequest = vi.fn();
vi.mock('node:https', () => ({ request: (...args: unknown[]) => httpsRequest(...args) }));

import {
  isBlockedAddress,
  isBlockedHostname,
  safeFetchAttachment,
  SafeFetchError,
} from './safe-fetch.js';

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback range'],
    ['10.0.0.5', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918'],
    ['172.31.255.254', 'RFC 1918 upper bound'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['142.250.72.14'],
    ['172.32.0.1'], // just outside 172.16/12
    ['192.169.0.1'], // just outside 192.168/16
    ['100.128.0.1'], // just outside 100.64/10
  ])('allows public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique-local'],
    ['fdaa:0:1::3', "Fly's 6PN network"],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('unwraps IPv4-mapped IPv6 rather than trusting the v6 form', () => {
    // ::ffff:127.0.0.1 is loopback wearing a costume.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses anything unparseable', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'app.localhost',
    'agenthelm-core.internal',
    'top1.nearest.of.agenthelm-core.internal',
    'printer.local',
    'metadata',
    '',
  ])('blocks %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  it.each(['example.com', 'files.example.co.uk', 'cdn.example.com.'])(
    'allows %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// Fetch behaviour
// ---------------------------------------------------------------------------

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** Queue of responses returned by successive https.request calls. */
function primeHttps(responses: FakeResponse[]): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];

  httpsRequest.mockImplementation((options: Record<string, unknown>, callback: (r: unknown) => void) => {
    calls.push(options);
    const next = responses.shift() ?? { status: 200, body: Buffer.from('ok') };

    const request = {
      on: vi.fn(),
      end: vi.fn(() => {
        const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
        const response = {
          statusCode: next.status,
          headers: next.headers ?? {},
          on: (event: string, handler: (arg?: unknown) => void) => {
            (handlers[event] ??= []).push(handler);
            return response;
          },
        };
        callback(response);
        for (const handler of handlers.data ?? []) handler(next.body ?? Buffer.from('ok'));
        for (const handler of handlers.end ?? []) handler();
      }),
      destroy: vi.fn(),
    };
    return request;
  });

  return { calls };
}

beforeEach(() => {
  dnsLookup.mockReset();
  httpsRequest.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('safeFetchAttachment — scheme and host guards', () => {
  it('refuses plaintext http', async () => {
    await expect(safeFetchAttachment('http://example.com/a.pdf')).rejects.toThrow(
      /only https:\/\/ URLs/
    );
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/a', 'gopher://example.com/'])(
    'refuses %s',
    async (url) => {
      await expect(safeFetchAttachment(url)).rejects.toThrow(SafeFetchError);
    }
  );

  it('refuses an internal hostname without ever resolving it', async () => {
    await expect(
      safeFetchAttachment('https://agenthelm-core.internal/secrets')
    ).rejects.toThrow(/internal to the Reins infrastructure/);
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('refuses a literal private IP', async () => {
    await expect(safeFetchAttachment('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private or reserved network/
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(safeFetchAttachment('not a url')).rejects.toThrow(/not a valid URL/);
  });
});

describe('safeFetchAttachment — DNS validation', () => {
  it('refuses when the hostname resolves to a private address', async () => {
    dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    await expect(safeFetchAttachment('https://evil.example.com/a.pdf')).rejects.toThrow(
      /resolves to 10\.1\.2\.3/
    );
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    // Returning one public and one private address must not be a coin flip.
    dnsLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    await expect(safeFetchAttachment('https://evil.example.com/a.pdf')).rejects.toThrow(
      /resolves to 127\.0\.0\.1/
    );
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('surfaces a resolution failure', async () => {
    dnsLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(safeFetchAttachment('https://nope.example.com/a')).rejects.toThrow(
      /Could not resolve/
    );
  });
});

describe('safeFetchAttachment — DNS rebinding', () => {
  it('pins the validated address so a second resolution cannot redirect the socket', async () => {
    // First lookup answers public; a rebinding attacker would answer the
    // *second* lookup with a private address. Because the connection uses a
    // custom `lookup` returning the pinned address, there is no second lookup.
    dnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const { calls } = primeHttps([{ status: 200, body: Buffer.from('payload') }]);
    const result = await safeFetchAttachment('https://rebind.example.com/a.pdf');

    expect(result.bytes.toString()).toBe('payload');
    expect(dnsLookup).toHaveBeenCalledTimes(1);

    // The socket is directed at the validated address, not the hostname.
    const pinned = calls[0].lookup as (h: string, o: object, cb: (...a: never[]) => void) => void;

    // Scalar form: callback(err, address, family).
    const scalar: unknown[] = [];
    pinned('rebind.example.com', {}, ((_e: unknown, address: string) => {
      scalar.push(address);
    }) as never);
    expect(scalar).toEqual(['93.184.216.34']);

    // Array form. Node calls lookup with {all: true} in practice, and the
    // callback then REQUIRES an array — answering with the scalar form fails
    // the request with ERR_INVALID_IP_ADDRESS. Verified against real Node.
    const all: unknown[] = [];
    pinned('rebind.example.com', { all: true }, ((_e: unknown, addresses: unknown) => {
      all.push(addresses);
    }) as never);
    expect(all).toEqual([[{ address: '93.184.216.34', family: 4 }]]);
  });

  it('pins an IPv6 address with the correct family', async () => {
    dnsLookup.mockResolvedValueOnce([{ address: '2606:4700::1111', family: 6 }]);
    const { calls } = primeHttps([{ status: 200, body: Buffer.from('x') }]);
    await safeFetchAttachment('https://v6.example.com/a.pdf');

    const pinned = calls[0].lookup as (h: string, o: object, cb: (...a: never[]) => void) => void;
    const all: unknown[] = [];
    pinned('v6.example.com', { all: true }, ((_e: unknown, addresses: unknown) => {
      all.push(addresses);
    }) as never);
    expect(all).toEqual([[{ address: '2606:4700::1111', family: 6 }]]);
  });
});

describe('safeFetchAttachment — redirects', () => {
  it('re-validates every hop and blocks a redirect to the metadata endpoint', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    primeHttps([
      { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } },
    ]);

    await expect(safeFetchAttachment('https://public.example.com/a.pdf')).rejects.toThrow(
      /private or reserved network/
    );
  });

  it('blocks a redirect that downgrades to http', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    primeHttps([{ status: 302, headers: { location: 'http://public.example.com/a.pdf' } }]);

    await expect(safeFetchAttachment('https://public.example.com/a.pdf')).rejects.toThrow(
      /only https:\/\/ URLs/
    );
  });

  it('follows a safe redirect', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    primeHttps([
      { status: 302, headers: { location: 'https://cdn.example.com/real.pdf' } },
      { status: 200, body: Buffer.from('final') },
    ]);

    const result = await safeFetchAttachment('https://public.example.com/a.pdf');
    expect(result.bytes.toString()).toBe('final');
    expect(result.finalUrl).toBe('https://cdn.example.com/real.pdf');
  });

  it('gives up after too many redirects', async () => {
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    primeHttps(
      Array.from({ length: 6 }, () => ({
        status: 302,
        headers: { location: 'https://public.example.com/loop' },
      }))
    );

    await expect(safeFetchAttachment('https://public.example.com/a.pdf')).rejects.toThrow(
      /Too many redirects/
    );
  });
});

describe('safeFetchAttachment — response handling', () => {
  beforeEach(() => dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]));

  it('extracts the MIME type and filename from headers', async () => {
    primeHttps([
      {
        status: 200,
        headers: {
          'content-type': 'application/pdf; charset=binary',
          'content-disposition': 'attachment; filename="Q3 Report.pdf"',
        },
        body: Buffer.from('%PDF-1.4'),
      },
    ]);

    const result = await safeFetchAttachment('https://example.com/download');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename).toBe('Q3 Report.pdf');
  });

  it('prefers the RFC 2231 filename form', async () => {
    primeHttps([
      {
        status: 200,
        headers: { 'content-disposition': "attachment; filename=\"_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" },
        body: Buffer.from('x'),
      },
    ]);

    const result = await safeFetchAttachment('https://example.com/download');
    expect(result.filename).toBe('résumé.pdf');
  });

  it('surfaces a non-2xx status', async () => {
    primeHttps([{ status: 404 }]);
    await expect(safeFetchAttachment('https://example.com/missing')).rejects.toThrow(
      /HTTP 404/
    );
  });

  it('sends no credentials', async () => {
    const { calls } = primeHttps([{ status: 200, body: Buffer.from('x') }]);
    await safeFetchAttachment('https://example.com/a.pdf');

    const headers = calls[0].headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
  });
});
