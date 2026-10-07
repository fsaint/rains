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
import { PLUGIN_DOWNLOADS, pluginUrl, formatBytes } from './plugins';

const DOWNLOADS = join(__dirname, '..', 'public', 'downloads');

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

  it('gives every plugin a distinct id and file', () => {
    const ids = PLUGIN_DOWNLOADS.map((p) => p.id);
    const files = PLUGIN_DOWNLOADS.map((p) => p.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('pluginUrl', () => {
  it('serves from the dashboard\'s own origin', () => {
    expect(pluginUrl(PLUGIN_DOWNLOADS[0])).toBe('/downloads/helm-chatgpt-0.2.0.zip');
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
