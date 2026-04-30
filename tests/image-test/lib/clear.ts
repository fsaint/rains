/**
 * Clear all ephemeral test apps and pushed images from the development org.
 *
 * What it deletes:
 *   - All Fly apps in FLY_TEST_ORG matching "reins-imgtest-*" (ephemeral test apps)
 *   - All image tags pushed to registry.fly.io/reins-imgtest (the variant images)
 *
 * What it does NOT delete:
 *   - The "reins-imgtest" registry app itself (needed to push future images)
 *
 * Usage:
 *   npx tsx tests/image-test/lib/clear.ts [--dry-run]
 */

import * as fs from 'fs';
import * as path from 'path';

const FLY_API_BASE = 'https://api.machines.dev/v1';
const REGISTRY = 'registry.fly.io';
const REGISTRY_APP = 'reins-imgtest';

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnv() {
  const envFile = path.join(import.meta.dirname, '../.env.image-test');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function getFlyToken(): string {
  const t = process.env.FLY_API_TOKEN;
  if (!t) throw new Error('FLY_API_TOKEN not set');
  return t;
}

function getTestOrg(): string {
  return process.env.FLY_TEST_ORG || 'development-808';
}

// ---------------------------------------------------------------------------
// Fly apps
// ---------------------------------------------------------------------------

async function listTestApps(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getFlyToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `{
        organization(slug: "${getTestOrg()}") {
          apps { nodes { id name } }
        }
      }`,
    }),
  });

  const data = await res.json() as {
    data?: { organization?: { apps?: { nodes?: Array<{ id: string; name: string }> } } };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length) throw new Error(data.errors[0].message);

  const apps = data.data?.organization?.apps?.nodes ?? [];
  // Only ephemeral test apps — skip the base "reins-imgtest" registry app
  return apps.filter((a) => a.name !== REGISTRY_APP && a.name.startsWith(REGISTRY_APP + '-'));
}

async function deleteApp(appName: string): Promise<void> {
  const res = await fetch(`${FLY_API_BASE}/apps/${appName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${getFlyToken()}` },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Failed to delete app ${appName}: ${res.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Registry images (Docker Distribution API v2)
// ---------------------------------------------------------------------------

function registryAuth(): string {
  // Fly registry accepts HTTP Basic auth: user=x, password=API_TOKEN
  return `Basic ${Buffer.from(`x:${getFlyToken()}`).toString('base64')}`;
}

async function listTags(): Promise<string[]> {
  const res = await fetch(`https://${REGISTRY}/v2/${REGISTRY_APP}/tags/list`, {
    headers: { Authorization: registryAuth() },
  });

  if (res.status === 404) return []; // no tags yet
  if (!res.ok) {
    console.warn(`  Could not list registry tags: ${res.status} ${await res.text()}`);
    return [];
  }

  const data = await res.json() as { tags?: string[] | null };
  return data.tags ?? [];
}

async function getManifestDigest(tag: string): Promise<string | null> {
  const res = await fetch(`https://${REGISTRY}/v2/${REGISTRY_APP}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: registryAuth(),
      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
    },
  });

  if (!res.ok) return null;
  return res.headers.get('Docker-Content-Digest');
}

async function deleteManifest(digest: string): Promise<void> {
  const res = await fetch(`https://${REGISTRY}/v2/${REGISTRY_APP}/manifests/${digest}`, {
    method: 'DELETE',
    headers: { Authorization: registryAuth() },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Failed to delete manifest ${digest}: ${res.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('Dry run — nothing will be deleted\n');

  let hadErrors = false;

  // 1. Ephemeral test apps
  console.log(`Scanning for ephemeral test apps in org "${getTestOrg()}"...`);
  let testApps: Array<{ id: string; name: string }> = [];
  try {
    testApps = await listTestApps();
  } catch (err) {
    console.error('  Failed to list apps:', err);
    hadErrors = true;
  }

  if (testApps.length === 0) {
    console.log('  No ephemeral test apps found');
  } else {
    for (const app of testApps) {
      if (dryRun) {
        console.log(`  [dry-run] Would delete app: ${app.name}`);
      } else {
        try {
          await deleteApp(app.name);
          console.log(`  Deleted app: ${app.name}`);
        } catch (err) {
          console.error(`  Error deleting app ${app.name}:`, err);
          hadErrors = true;
        }
      }
    }
  }

  // 2. Registry images
  console.log(`\nScanning registry images for ${REGISTRY}/${REGISTRY_APP}...`);
  try {
    const tags = await listTags();

    if (tags.length === 0) {
      console.log('  No images found');
    } else {
      for (const tag of tags) {
        const digest = await getManifestDigest(tag);
        if (!digest) {
          console.warn(`  Could not get digest for tag: ${tag}`);
          continue;
        }

        if (dryRun) {
          console.log(`  [dry-run] Would delete image: ${tag} (${digest.slice(0, 19)}...)`);
        } else {
          try {
            await deleteManifest(digest);
            console.log(`  Deleted image: ${tag}`);
          } catch (err) {
            console.error(`  Error deleting image ${tag}:`, err);
            hadErrors = true;
          }
        }
      }
    }
  } catch (err) {
    console.error('  Registry cleanup failed:', err);
    hadErrors = true;
  }

  console.log('\nDone.');
  process.exit(hadErrors ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
