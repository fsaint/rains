/**
 * Egress-guarded HTTPS fetch for the `url` attachment source.
 *
 * THREAT MODEL — read before changing anything here.
 *
 * The Gmail server runs in-process inside the backend (agenthelm-core), which
 * holds every user's decrypted OAuth tokens and sits on Fly's private 6PN
 * network with `.internal` DNS and a cloud metadata endpoint. A fetch whose URL
 * is chosen by a model is therefore a full SSRF primitive against the most
 * sensitive process in the system.
 *
 * Two properties make the guard actually hold, and both are load-bearing:
 *
 *  1. The resolved IP is PINNED. Validating a hostname's address and then
 *     handing the hostname to the HTTP client re-resolves it, leaving a TOCTOU
 *     window in which an attacker-controlled DNS server can answer the second
 *     lookup with 127.0.0.1 (DNS rebinding). We resolve once, validate every
 *     returned address, and then connect to the validated address via a custom
 *     `lookup`, so the socket cannot land anywhere else.
 *
 *  2. Redirects are followed MANUALLY and re-validated at every hop. A public
 *     URL that 302s to 169.254.169.254 would otherwise walk straight past a
 *     check performed only on the original URL.
 */

import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { MAX_ATTACHMENT_BYTES, formatBytes } from './limits.js';

/** Total time budget for a single fetch, including redirects. */
const FETCH_TIMEOUT_MS = 15_000;

/** Maximum redirect hops. Each one is fully re-validated. */
const MAX_REDIRECTS = 3;

export class SafeFetchError extends Error {}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** IPv4 ranges that must never be reachable. */
const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // RFC 6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — cloud metadata lives here
  ['172.16.0.0', 12], // RFC 1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function ipv4ToInt(address: string): number {
  return address
    .split('.')
    .reduce((accumulator, octet) => (accumulator << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIPv4(address: string): boolean {
  const value = ipv4ToInt(address);
  return BLOCKED_IPV4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms must be unwrapped
  // and judged as IPv4 — otherwise ::ffff:127.0.0.1 sails through.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);

  if (normalized === '::1' || normalized === '::') return true;

  const head = normalized.split(':')[0];
  if (head === '') return true; // any other ::-prefixed form

  const leading = parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (Number.isNaN(leading)) return true;

  // fc00::/7 unique-local (covers Fly's fdaa::/16 6PN network)
  if ((leading & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((leading & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((leading & 0xff00) === 0xff00) return true;

  return false;
}

/** True when an address must not be connected to. */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return isBlockedIPv4(address);
  if (isIPv6(address)) return isBlockedIPv6(address);
  return true; // unparseable — refuse
}

/** Hostnames that resolve inside the private infrastructure. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  // A dotless name can only be an internal short name (e.g. "metadata").
  // Literal IPs are handled separately and legitimately contain no dot.
  if (!host.includes('.') && !isIPv4(host) && !isIPv6(host)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface SafeFetchResult {
  bytes: Buffer;
  mimeType?: string;
  filename?: string;
  finalUrl: string;
}

/** Resolve a hostname and reject unless EVERY returned address is permitted. */
async function resolveAndValidate(hostname: string): Promise<string> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SafeFetchError(
        `Refusing to fetch from ${hostname}: that address is on a private or reserved network.`
      );
    }
    return hostname;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new SafeFetchError(`Could not resolve "${hostname}".`);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError(`Could not resolve "${hostname}".`);
  }

  // Every answer must be safe. Picking only the safe ones would let a host that
  // returns one public and one private address through on a coin flip.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SafeFetchError(
        `Refusing to fetch from "${hostname}": it resolves to ${address}, on a private or reserved network.`
      );
    }
  }
  return addresses[0].address;
}

function parseFilename(contentDisposition: string | undefined): string | undefined {
  if (!contentDisposition) return undefined;
  const extended = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      /* fall through to the ASCII form */
    }
  }
  const basic = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return basic?.[1];
}

/** One hop: validate, connect to the pinned address, collect the body. */
function fetchOnce(
  url: URL,
  pinnedAddress: string,
  deadline: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new SafeFetchError('Timed out fetching the attachment.'));
      return;
    }

    const request = httpsRequest(
      {
        protocol: 'https:',
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        // Connect to the address we already validated. TLS `servername`
        // defaults to `host`, so certificate validation is unaffected.
        lookup: (_hostname, options, callback) => {
          const family = isIPv6(pinnedAddress) ? 6 : 4;
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [
              { address: pinnedAddress, family },
            ]);
          } else {
            callback(null, pinnedAddress, family);
          }
        },
        headers: {
          // No credentials of any kind are forwarded.
          accept: '*/*',
          'user-agent': 'Reins-Attachment-Fetcher/1.0',
        },
        timeout: remaining,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_ATTACHMENT_BYTES) {
            request.destroy();
            reject(
              new SafeFetchError(
                `The file at ${url.href} is larger than the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit.`
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        );
        response.on('error', (error) => reject(new SafeFetchError(error.message)));
      }
    );

    request.on('timeout', () => {
      request.destroy();
      reject(new SafeFetchError('Timed out fetching the attachment.'));
    });
    request.on('error', (error) => reject(new SafeFetchError(error.message)));
    request.end();
  });
}

/**
 * Fetch a URL for use as an attachment, with the SSRF guard described above.
 *
 * HTTPS only — plaintext HTTP would let a network position rewrite the file
 * being attached to an email the user is about to approve.
 */
export async function safeFetchAttachment(rawUrl: string): Promise<SafeFetchResult> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let current: URL;

  try {
    current = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`"${rawUrl}" is not a valid URL.`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:') {
      throw new SafeFetchError(
        `Refusing to fetch "${current.href}": only https:// URLs can be attached.`
      );
    }
    if (isBlockedHostname(current.hostname)) {
      throw new SafeFetchError(
        `Refusing to fetch from "${current.hostname}": that host is internal to the Reins infrastructure.`
      );
    }

    // Re-validated on EVERY hop — a public URL may redirect to a private one.
    const pinnedAddress = await resolveAndValidate(current.hostname);
    const response = await fetchOnce(current, pinnedAddress, deadline);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      const target = Array.isArray(location) ? location[0] : location;
      if (!target) {
        throw new SafeFetchError(`Got a ${response.status} with no destination.`);
      }
      if (hop === MAX_REDIRECTS) {
        throw new SafeFetchError(`Too many redirects fetching "${rawUrl}".`);
      }
      current = new URL(target, current);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError(
        `The server returned HTTP ${response.status} for "${current.href}".`
      );
    }

    const contentType = response.headers['content-type'];
    const rawType = Array.isArray(contentType) ? contentType[0] : contentType;
    const disposition = response.headers['content-disposition'];

    return {
      bytes: response.body,
      mimeType: rawType?.split(';')[0].trim(),
      filename: parseFilename(Array.isArray(disposition) ? disposition[0] : disposition),
      finalUrl: current.href,
    };
  }

  throw new SafeFetchError(`Too many redirects fetching "${rawUrl}".`);
}
