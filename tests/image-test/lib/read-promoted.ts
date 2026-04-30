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

/**
 * Apply a promotion to production:
 *
 * - openclaw: deploys the promoted image to `agentx-openclaw` via `flyctl deploy`.
 *   The existing getOpenClawImage() in backend/src/providers/fly.ts already reads
 *   from the live agentx-openclaw machines, so this is sufficient for both new
 *   agent provisioning and /redeploy-agent to pick up the new image automatically.
 *
 * - hermes: prints the `flyctl secrets set` command the user needs to run on the
 *   backend Fly app (app name may vary, so we print rather than execute).
 *
 * Returns true if the apply succeeded (or was not applicable), false on error.
 */
export async function applyPromotion(
  runtime: 'openclaw' | 'hermes',
  image: string,
): Promise<boolean> {
  const { spawnSync } = await import('child_process');

  if (runtime === 'openclaw') {
    const openclaw_app = process.env.OPENCLAW_APP || 'agentx-openclaw';
    console.log(`Deploying ${image} to ${openclaw_app}...`);
    const result = spawnSync(
      'flyctl',
      ['deploy', '--image', image, '--app', openclaw_app, '--strategy', 'immediate'],
      { stdio: 'inherit', encoding: 'utf8' },
    );
    if (result.status !== 0) {
      console.error(`flyctl deploy failed with exit code ${result.status}`);
      return false;
    }
    console.log(`  Deployed to ${openclaw_app} — new agents and /redeploy-agent will use this image.`);
    return true;
  }

  if (runtime === 'hermes') {
    // HERMES_IMAGE is read from the backend process environment. When the backend
    // runs on Fly, set it as a secret on the backend app. Print the command since
    // we don't have the backend app name here.
    const backendApp = process.env.REINS_BACKEND_APP;
    if (backendApp) {
      console.log(`Setting HERMES_IMAGE on ${backendApp}...`);
      const result = spawnSync(
        'flyctl',
        ['secrets', 'set', `HERMES_IMAGE=${image}`, '--app', backendApp],
        { stdio: 'inherit', encoding: 'utf8' },
      );
      if (result.status !== 0) {
        console.error(`flyctl secrets set failed with exit code ${result.status}`);
        return false;
      }
      console.log(`  HERMES_IMAGE updated on ${backendApp}.`);
    } else {
      console.log(`\nTo apply hermes promotion to production, run:`);
      console.log(`  flyctl secrets set HERMES_IMAGE=${image} --app <your-backend-app>`);
      console.log(`  (or set REINS_BACKEND_APP env var to automate this step)`);
    }
    return true;
  }

  return true;
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
