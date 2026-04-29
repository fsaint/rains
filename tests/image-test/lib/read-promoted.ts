/**
 * Read the blessed production image for a given runtime from promoted.yaml.
 *
 * CLI usage:
 *   npx tsx tests/image-test/lib/read-promoted.ts openclaw   → image tag or "null"
 *   npx tsx tests/image-test/lib/read-promoted.ts hermes     → image tag or "null"
 *   npx tsx tests/image-test/lib/read-promoted.ts            → full promoted.yaml contents as JSON
 *
 * Programmatic usage:
 *   import { getPromotedImage, getPromoted } from './read-promoted.js'
 *   const image = await getPromotedImage('openclaw')
 */

import * as fs from 'fs';
import * as path from 'path';

const PROMOTED_PATH = path.join(
  path.dirname(import.meta.url.replace('file://', '')),
  '../promoted.yaml',
);

export interface PromotedEntry {
  variant: string;
  image: string;
  tested_at: string;
  scenarios_passed: string[];
}

export interface PromotedIndex {
  openclaw: PromotedEntry | null;
  hermes: PromotedEntry | null;
}

function parsePromotedYaml(content: string): PromotedIndex {
  const result: PromotedIndex = { openclaw: null, hermes: null };

  for (const runtime of ['openclaw', 'hermes'] as const) {
    const block = content.match(new RegExp(`^${runtime}:\\s*\\n([\\s\\S]*?)(?=^\\w|$)`, 'm'));
    if (!block || block[0].includes('null')) continue;

    const entry: Partial<PromotedEntry> = {};
    const lines = block[1].split('\n');
    for (const line of lines) {
      const m = line.match(/^\s+(\w+):\s*(.+)$/);
      if (!m) continue;
      const [, key, val] = m;
      const clean = val.trim().replace(/^["']|["']$/g, '');
      if (key === 'variant') entry.variant = clean;
      else if (key === 'image') entry.image = clean;
      else if (key === 'tested_at') entry.tested_at = clean;
      else if (key === 'scenarios_passed') {
        entry.scenarios_passed = clean
          .replace(/[\[\]]/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    if (entry.variant && entry.image) {
      result[runtime] = entry as PromotedEntry;
    }
  }

  return result;
}

export function getPromoted(): PromotedIndex {
  if (!fs.existsSync(PROMOTED_PATH)) {
    return { openclaw: null, hermes: null };
  }
  return parsePromotedYaml(fs.readFileSync(PROMOTED_PATH, 'utf8'));
}

export function getPromotedImage(runtime: 'openclaw' | 'hermes'): string | null {
  return getPromoted()[runtime]?.image ?? null;
}

export function writePromotion(
  runtime: 'openclaw' | 'hermes',
  entry: PromotedEntry,
): void {
  const current = getPromoted();
  current[runtime] = entry;

  const lines = ['# Blessed production images — updated automatically by runner.ts --promote', '# Read by: npx tsx tests/image-test/lib/read-promoted.ts <openclaw|hermes>', ''];

  for (const rt of ['openclaw', 'hermes'] as const) {
    const e = current[rt];
    if (!e) {
      lines.push(`${rt}: null`);
    } else {
      lines.push(`${rt}:`);
      lines.push(`  variant: ${e.variant}`);
      lines.push(`  image: ${e.image}`);
      lines.push(`  tested_at: "${e.tested_at}"`);
      lines.push(`  scenarios_passed: [${e.scenarios_passed.join(', ')}]`);
    }
    lines.push('');
  }

  fs.writeFileSync(PROMOTED_PATH, lines.join('\n'));
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = process.argv[2] as 'openclaw' | 'hermes' | undefined;

  if (!runtime) {
    console.log(JSON.stringify(getPromoted(), null, 2));
  } else if (runtime === 'openclaw' || runtime === 'hermes') {
    const image = getPromotedImage(runtime);
    console.log(image ?? 'null');
    if (!image) process.exit(1);
  } else {
    console.error(`Unknown runtime: ${runtime}. Use "openclaw" or "hermes".`);
    process.exit(1);
  }
}
