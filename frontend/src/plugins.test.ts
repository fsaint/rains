/**
 * The plugin list against the files on disk.
 *
 * A listed plugin whose zip was never committed is a download button that
 * 404s, and nothing else in the build would notice: the manifest is hand
 * written and the files are static assets Vite copies verbatim. So the
 * load-bearing test here reads the directory rather than any code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PLUGIN_DOWNLOADS, pluginUrl, formatBytes } from './plugins';

const DOWNLOADS = join(__dirname, '..', 'public', 'downloads');

/** Every entry's text, read from the zip's local headers (stored or deflated). */
function zipText(buf: Buffer): string {
  const parts: string[] = [];
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const data = buf.subarray(start, start + size);
    parts.push((method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    at = start + size;
  }
  return parts.join('\n');
}

describe('every listed plugin is actually shipped', () => {
  it.each(PLUGIN_DOWNLOADS.map((p) => [p.client, p] as const))(
    '%s: the file exists in public/downloads',
    (_client, plugin) => {
      expect(existsSync(join(DOWNLOADS, plugin.file)), `missing ${plugin.file}`).toBe(true);
    }
  );

  /** A wrong size is a small lie, and it is free to keep honest. */
  it.each(PLUGIN_DOWNLOADS.map((p) => [p.client, p] as const))(
    '%s: the stated size matches the file',
    (_client, plugin) => {
      expect(statSync(join(DOWNLOADS, plugin.file)).size).toBe(plugin.bytes);
    }
  );

  /** The version in the filename and the version shown must not drift apart. */
  it.each(PLUGIN_DOWNLOADS.map((p) => [p.client, p] as const))(
    '%s: the filename carries the stated version',
    (_client, plugin) => {
      expect(plugin.file).toContain(plugin.version);
    }
  );

  it('is a real zip, not a renamed directory or an empty placeholder', () => {
    for (const plugin of PLUGIN_DOWNLOADS) {
      const head = readFileSync(join(DOWNLOADS, plugin.file)).subarray(0, 2).toString('latin1');
      expect(head, `${plugin.file} is not a zip`).toBe('PK');
    }
  });

  it('tells people how to install every plugin', () => {
    for (const plugin of PLUGIN_DOWNLOADS) {
      expect(plugin.install.length, `${plugin.client} has no install steps`).toBeGreaterThan(0);
    }
  });

  /**
   * A shipped plugin is the same file for every user, so it may only point at
   * the discovery endpoint. An agent URL in it would hand everyone one person's agent.
   */
  it('carries no agent endpoint, only the discovery endpoint', () => {
    for (const plugin of PLUGIN_DOWNLOADS) {
      const text = zipText(readFileSync(join(DOWNLOADS, plugin.file)));
      expect(text).toContain('https://app.helm.mom/mcp');
      expect(text, `${plugin.file} names an agent endpoint`).not.toMatch(/helm\.mom\/mcp\/[A-Za-z0-9]/);
    }
  });

  it('gives every plugin a distinct id and file', () => {
    const ids = PLUGIN_DOWNLOADS.map((p) => p.id);
    const files = PLUGIN_DOWNLOADS.map((p) => p.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
  });
});

/**
 * Claude Code installs from marketplace.json, which pins the archive by URL and
 * sha256. A stale pin makes every install fail, so it must match the file shipped.
 */
describe('the Claude Code marketplace', () => {
  const market = JSON.parse(readFileSync(join(DOWNLOADS, 'marketplace.json'), 'utf8'));
  const claude = PLUGIN_DOWNLOADS.find((p) => p.id === 'claude')!;
  const entry = market.plugins.find((p: { name: string }) => p.name === 'helm');

  it('points at the listed Claude plugin', () => {
    expect(entry.version).toBe(claude.version);
    expect(entry.source.source).toBe('archive');
    expect(entry.source.url).toBe(`https://app.helm.mom/downloads/${claude.file}`);
  });

  it('pins the sha256 of the shipped file', () => {
    const digest = createHash('sha256').update(readFileSync(join(DOWNLOADS, claude.file))).digest('hex');
    expect(entry.source.sha256).toBe(digest);
  });
});

describe('pluginUrl', () => {
  it('serves from the dashboard\'s own origin', () => {
    expect(pluginUrl(PLUGIN_DOWNLOADS[0])).toBe(`/downloads/${PLUGIN_DOWNLOADS[0].file}`);
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [9470, '9.2 KB'],
    [204800, '200 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
