/**
 * Image test runner — orchestrates build → deploy → test → teardown → report.
 *
 * Usage:
 *   npx tsx tests/image-test/lib/runner.ts \
 *     --variant tests/image-test/variants/baseline.yaml \
 *     --scenario tests/image-test/scenarios/basic-browser.yaml \
 *     [--scenario tests/image-test/scenarios/opentable-search.yaml] \
 *     [--skip-build]
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp, createTestMachine, waitForHealthy, destroyTest } from './lifecycle.js';
import { writePromotion } from './read-promoted.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VariantYaml {
  name: string;
  runtime?: 'openclaw' | 'hermes';
  description?: string;
  dockerfile?: string;
  build_args: Record<string, string>;
}

interface Assertion {
  type:
    | 'reply_contains'
    | 'reply_contains_any'
    | 'reply_not_contains'
    | 'screenshot_present'
    | 'reply_min_length';
  value?: string | number;
  values?: string[];
}

interface ScenarioYaml {
  name: string;
  description?: string;
  timeout_seconds: number;
  prompt: string;
  assertions: Assertion[];
}

interface TgTestResult {
  ok: boolean;
  reply: string;
  screenshots: string[];
  elapsed_s: number;
  error?: string;
}

interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  reason: string;
}

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  elapsed_s: number;
  reply: string;
  screenshots: string[];
  assertions: AssertionResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// YAML parsing (minimal, no external dependency)
// ---------------------------------------------------------------------------

function parseVariantYaml(filePath: string): VariantYaml {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const result: VariantYaml = { name: '', build_args: {} };
  let inBuildArgs = false;

  for (const line of lines) {
    if (line.startsWith('name:')) {
      result.name = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
    } else if (line.startsWith('runtime:')) {
      result.runtime = line.split(':')[1].trim() as 'openclaw' | 'hermes';
    } else if (line.startsWith('description:')) {
      result.description = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
    } else if (line.startsWith('dockerfile:')) {
      result.dockerfile = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
    } else if (line.startsWith('build_args:')) {
      inBuildArgs = true;
    } else if (inBuildArgs && /^  \w/.test(line)) {
      const m = line.match(/^  (\w+):\s*['"]?(.*?)['"]?\s*$/);
      if (m) result.build_args[m[1]] = m[2];
    } else if (/^\w/.test(line) && !line.startsWith('build_args:')) {
      inBuildArgs = false;
    }
  }
  return result;
}

function parseScenarioYaml(filePath: string): ScenarioYaml {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const result: ScenarioYaml = {
    name: '',
    timeout_seconds: 120,
    prompt: '',
    assertions: [],
  };
  let inPrompt = false;
  let promptLines: string[] = [];
  let inAssertions = false;
  let currentAssertion: Partial<Assertion> | null = null;

  for (const line of lines) {
    if (inPrompt) {
      if (/^\w/.test(line) && !line.startsWith('  ')) {
        result.prompt = promptLines.join('\n').trim();
        inPrompt = false;
        promptLines = [];
      } else {
        promptLines.push(line.replace(/^  /, ''));
        continue;
      }
    }

    if (line.startsWith('name:')) {
      result.name = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
    } else if (line.startsWith('description:')) {
      result.description = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
    } else if (line.startsWith('timeout_seconds:')) {
      result.timeout_seconds = parseInt(line.split(':')[1].trim(), 10);
    } else if (line.startsWith('prompt:')) {
      inPrompt = true;
    } else if (line.startsWith('assertions:')) {
      inAssertions = true;
    } else if (inAssertions) {
      if (/^  - type:/.test(line)) {
        if (currentAssertion) result.assertions.push(currentAssertion as Assertion);
        currentAssertion = { type: line.split(':')[1].trim() as Assertion['type'] };
      } else if (/^    value:/.test(line) && currentAssertion) {
        const raw = line.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
        currentAssertion.value = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
      } else if (/^    values:/.test(line) && currentAssertion) {
        // inline array: values: ["a", "b"]
        const arrMatch = line.match(/\[(.+)\]/);
        if (arrMatch) {
          currentAssertion.values = arrMatch[1]
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
        }
      }
    }
  }
  if (inPrompt && promptLines.length) result.prompt = promptLines.join('\n').trim();
  if (currentAssertion) result.assertions.push(currentAssertion as Assertion);

  return result;
}

// ---------------------------------------------------------------------------
// Assertion evaluation
// ---------------------------------------------------------------------------

function evaluate(assertion: Assertion, tgResult: TgTestResult): AssertionResult {
  const reply = tgResult.reply.toLowerCase();

  switch (assertion.type) {
    case 'reply_contains': {
      const val = String(assertion.value || '').toLowerCase();
      const passed = reply.includes(val);
      return { assertion, passed, reason: passed ? 'ok' : `Reply does not contain "${assertion.value}"` };
    }
    case 'reply_contains_any': {
      const vals = (assertion.values || []).map((v) => v.toLowerCase());
      const passed = vals.some((v) => reply.includes(v));
      return {
        assertion,
        passed,
        reason: passed ? 'ok' : `Reply does not contain any of: ${assertion.values?.join(', ')}`,
      };
    }
    case 'reply_not_contains': {
      const found = (assertion.values || []).find((v) => reply.includes(v.toLowerCase()));
      const passed = !found;
      return { assertion, passed, reason: passed ? 'ok' : `Reply contains forbidden word: "${found}"` };
    }
    case 'screenshot_present': {
      const passed = tgResult.screenshots.length > 0;
      return { assertion, passed, reason: passed ? 'ok' : 'No screenshots captured' };
    }
    case 'reply_min_length': {
      const minLen = Number(assertion.value || 0);
      const passed = tgResult.reply.length >= minLen;
      return {
        assertion,
        passed,
        reason: passed ? 'ok' : `Reply length ${tgResult.reply.length} < minimum ${minLen}`,
      };
    }
    default:
      return { assertion, passed: false, reason: `Unknown assertion type: ${(assertion as Assertion).type}` };
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildImage(variantYamlPath: string, skipBuild: boolean): void {
  if (skipBuild) {
    console.log('Skipping build (--skip-build)');
    return;
  }

  const buildScript = path.join(path.dirname(import.meta.url.replace('file://', '')), 'build.sh');
  console.log(`\nBuilding image variant: ${variantYamlPath}`);
  const result = spawnSync('bash', [buildScript, variantYamlPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Image build failed with exit code ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: ScenarioYaml,
  botUsername: string,
  resultsDir: string,
): Promise<ScenarioResult> {
  console.log(`\n--- Scenario: ${scenario.name} ---`);
  console.log(`Prompt: ${scenario.prompt.slice(0, 80)}...`);

  const scriptPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'tg-browser-test.py');

  // Pass --no-new: session reset is handled once by the runner before warmup,
  // so scenarios run without triggering another CDP disconnect cycle.
  const proc = spawnSync(
    'python3',
    [scriptPath, '--no-new', botUsername, scenario.prompt, String(scenario.timeout_seconds), resultsDir],
    { encoding: 'utf8', timeout: (scenario.timeout_seconds + 60) * 1000, env: process.env },
  );

  let tgResult: TgTestResult;
  try {
    tgResult = JSON.parse(proc.stdout || '{}');
  } catch {
    tgResult = {
      ok: false,
      error: `Failed to parse tg-browser-test.py output: ${proc.stdout}\n${proc.stderr}`,
      reply: '',
      screenshots: [],
      elapsed_s: 0,
    };
  }

  if (!tgResult.ok) {
    return {
      scenario: scenario.name,
      passed: false,
      elapsed_s: tgResult.elapsed_s,
      reply: tgResult.reply,
      screenshots: tgResult.screenshots,
      assertions: [],
      error: tgResult.error,
    };
  }

  // Evaluate assertions
  const assertionResults = scenario.assertions.map((a) => evaluate(a, tgResult));
  const allPassed = assertionResults.every((r) => r.passed);

  return {
    scenario: scenario.name,
    passed: allPassed,
    elapsed_s: tgResult.elapsed_s,
    reply: tgResult.reply,
    screenshots: tgResult.screenshots,
    assertions: assertionResults,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI args
  let variantYamlPath = '';
  const scenarioYamlPaths: string[] = [];
  let skipBuild = false;
  let promote = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--variant' && args[i + 1]) {
      variantYamlPath = args[++i];
    } else if (args[i] === '--scenario' && args[i + 1]) {
      scenarioYamlPaths.push(args[++i]);
    } else if (args[i] === '--skip-build') {
      skipBuild = true;
    } else if (args[i] === '--promote') {
      promote = true;
    }
  }

  if (!variantYamlPath || scenarioYamlPaths.length === 0) {
    console.error('Usage: runner.ts --variant <yaml> --scenario <yaml> [--scenario <yaml>] [--skip-build] [--promote]');
    process.exit(1);
  }

  // Load env from .env.image-test if present
  const envFile = path.join(path.dirname(import.meta.url.replace('file://', '')), '../.env.image-test');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const raw = trimmed.slice(eqIdx + 1).trim();
          const value = raw.replace(/^["']|["']$/g, '');
          if (!process.env[key]) process.env[key] = value;
        }
      }
    }
  }

  const variant = parseVariantYaml(variantYamlPath);
  const scenarios = scenarioYamlPaths.map(parseScenarioYaml);

  // Results directory for this run
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(
    path.dirname(import.meta.url.replace('file://', '')),
    '../results',
    `${timestamp}-${variant.name}`,
  );
  fs.mkdirSync(runDir, { recursive: true });

  const image = `registry.fly.io/reins-imgtest:${variant.name}`;
  let appName = '';
  let machineId = '';
  const allResults: ScenarioResult[] = [];

  try {
    // 1. Build image
    buildImage(variantYamlPath, skipBuild);

    // 2. Create ephemeral test app + machine
    const botToken = process.env.TEST_BOT_TOKEN;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!botToken) throw new Error('TEST_BOT_TOKEN is required in .env.image-test');
    if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required in .env.image-test');

    appName = await createTestApp(variant.name);
    machineId = await createTestMachine(appName, image, {
      TELEGRAM_BOT_TOKEN: botToken,
      ANTHROPIC_API_KEY: anthropicKey,
      OPENCLAW_MODEL: process.env.OPENCLAW_MODEL || 'claude-sonnet-4-5',
      XVFB_RESOLUTION: variant.build_args.XVFB_RESOLUTION,
    });

    // 3. Wait for healthy
    await waitForHealthy(appName, machineId);

    // 4. Get bot username from env
    const botUsername = process.env.TEST_BOT_USERNAME;
    if (!botUsername) throw new Error('TEST_BOT_USERNAME is required — set it to your test bot @username');

    // 4b. Send /new once to reset session history and trigger Chrome CDP init,
    // then wait 70s for Chrome to fully reconnect. All subsequent calls use
    // --no-new so they don't re-trigger the expensive CDP reconnect cycle.
    console.log('\nSending /new and waiting 70s for Chrome CDP to reconnect...');
    const tgScript = path.join(path.dirname(import.meta.url.replace('file://', '')), 'tg-browser-test.py');
    const sendNewScript = `
import asyncio, os
from pathlib import Path
async def send_new():
    from telethon import TelegramClient
    api_id = int(os.environ["TELETHON_API_ID"])
    api_hash = os.environ["TELETHON_API_HASH"]
    session = os.path.expanduser(os.environ.get("TELETHON_SESSION", str(Path.home() / ".reins_imgtest_telethon.session")))
    async with TelegramClient(session, api_id, api_hash) as client:
        bot = await client.get_entity(os.environ["_RESET_BOT_USERNAME"])
        await client.send_message(bot, "/new")
asyncio.run(send_new())
`;
    spawnSync('python3', ['-c', sendNewScript], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, _RESET_BOT_USERNAME: botUsername },
    });
    // Chrome drops its CDP connection on /new and needs ~60s to reconnect.
    // Waiting 70s here ensures Chrome is accepting connections before warmup.
    await new Promise((r) => setTimeout(r, 70_000));

    // 4c. Warm-up: confirm Chrome is responding before running real scenarios.
    // Uses --no-new so it doesn't trigger another CDP disconnect cycle.
    console.log('\nWarming up browser (sending pre-flight ping)...');
    const warmupScript = path.join(path.dirname(import.meta.url.replace('file://', '')), 'tg-browser-test.py');
    spawnSync('python3', [warmupScript, '--no-new', botUsername, 'Open your browser and navigate to about:blank. Reply with the word "ready" when the browser is open.', '90', runDir], {
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    });
    console.log('Chrome warmed up. Starting scenarios.\n');

    // 5. Run scenarios
    for (const scenario of scenarios) {
      const result = await runScenario(scenario, botUsername, runDir);
      allResults.push(result);

      // Print inline result
      const status = result.passed ? 'PASS' : 'FAIL';
      console.log(`\n[${status}] ${result.scenario} (${result.elapsed_s}s)`);
      if (!result.passed) {
        if (result.error) console.log(`  Error: ${result.error}`);
        for (const a of result.assertions.filter((x) => !x.passed)) {
          console.log(`  Assertion failed: ${a.reason}`);
        }
      }
    }
  } finally {
    // 6. Teardown — always runs
    if (appName && machineId) {
      await destroyTest(appName, machineId);
    }
  }

  // 7. Save results
  const summary = {
    variant: variant.name,
    timestamp,
    image,
    scenarios: allResults,
    totals: {
      passed: allResults.filter((r) => r.passed).length,
      failed: allResults.filter((r) => !r.passed).length,
      total: allResults.length,
    },
  };

  const summaryPath = path.join(runDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // 8. Print summary
  console.log('\n' + '='.repeat(60));
  console.log(`Image Test Results — ${variant.name}`);
  console.log('='.repeat(60));
  for (const r of allResults) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.scenario} (${r.elapsed_s}s)`);
  }
  console.log('');
  console.log(`Total: ${summary.totals.passed}/${summary.totals.total} passed`);
  console.log(`Results saved: ${summaryPath}`);

  // 9. Promote if all scenarios passed and --promote flag is set
  if (promote) {
    if (summary.totals.failed > 0) {
      console.log('\nSkipping promotion — not all scenarios passed.');
    } else {
      const runtime = variant.runtime;
      if (!runtime) {
        console.log('\nSkipping promotion — variant has no "runtime" field (add runtime: openclaw or runtime: hermes).');
      } else {
        writePromotion(runtime, {
          variant: variant.name,
          image,
          tested_at: new Date().toISOString(),
          scenarios_passed: allResults.map((r) => r.scenario),
        });
        console.log(`\nPromoted ${variant.name} as production image for ${runtime}`);
        console.log(`  Image: ${image}`);
        console.log(`  Updated: tests/image-test/promoted.yaml`);
      }
    }
  }

  const exitCode = summary.totals.failed > 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Runner error:', err);
  process.exit(1);
});
