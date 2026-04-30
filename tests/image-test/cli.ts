#!/usr/bin/env npx tsx
/**
 * Image test CLI
 *
 * Usage:
 *   npx tsx tests/image-test/cli.ts                          # interactive
 *   npx tsx tests/image-test/cli.ts -v baseline -s ping      # direct
 *   npx tsx tests/image-test/cli.ts -v baseline -s ping -s basic-browser --promote --skip-build
 *
 * Flags:
 *   -v, --variant <name>      Variant name (e.g. baseline)
 *   -s, --scenario <name>     Scenario name (repeatable)
 *   --promote                 Promote to promoted.yaml if all pass
 *   --skip-build              Skip docker build (reuse pushed image)
 *   --list                    List available variants and scenarios
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VARIANTS_DIR = path.join(import.meta.dirname, 'variants');
const SCENARIOS_DIR = path.join(import.meta.dirname, 'scenarios');
const RUNNER = path.join(import.meta.dirname, 'lib/runner.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface YamlMeta {
  file: string;
  name: string;
  description?: string;
  runtime?: string;
}

function readMeta(dir: string): YamlMeta[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const name = (content.match(/^name:\s*(.+)/m)?.[1] ?? f.replace('.yaml', '')).trim();
      const description = content.match(/^description:\s*(.+)/m)?.[1]?.trim();
      const runtime = content.match(/^runtime:\s*(.+)/m)?.[1]?.trim();
      return { file: path.join(dir, f), name, description, runtime };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printList(items: YamlMeta[], idx: number) {
  const prefix = `  ${idx + 1}.`;
  const desc = items[idx].description ? `  — ${items[idx].description}` : '';
  const runtime = items[idx].runtime ? ` [${items[idx].runtime}]` : '';
  return `${prefix} ${items[idx].name}${runtime}${desc}`;
}

async function pick(rl: readline.Interface, prompt: string, items: YamlMeta[]): Promise<YamlMeta> {
  console.log(`\n${prompt}`);
  items.forEach((_, i) => console.log(printList(items, i)));
  while (true) {
    const answer = await rl.question(`\nEnter number [1-${items.length}]: `);
    const n = parseInt(answer.trim(), 10);
    if (n >= 1 && n <= items.length) return items[n - 1];
    console.log(`  Invalid — enter a number between 1 and ${items.length}`);
  }
}

async function pickMulti(rl: readline.Interface, prompt: string, items: YamlMeta[]): Promise<YamlMeta[]> {
  console.log(`\n${prompt}`);
  items.forEach((_, i) => console.log(printList(items, i)));
  while (true) {
    const answer = await rl.question(`\nEnter number(s), comma-separated (e.g. 1,3) or "all": `);
    const trimmed = answer.trim();
    if (trimmed.toLowerCase() === 'all') return items;
    const nums = trimmed.split(',').map((s) => parseInt(s.trim(), 10));
    if (nums.every((n) => n >= 1 && n <= items.length)) {
      return nums.map((n) => items[n - 1]);
    }
    console.log(`  Invalid — enter numbers between 1 and ${items.length}, or "all"`);
  }
}

async function confirm(rl: readline.Interface, prompt: string): Promise<boolean> {
  const answer = await rl.question(`${prompt} [y/N]: `);
  return answer.trim().toLowerCase() === 'y';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // --list
  if (args.includes('--list')) {
    const variants = readMeta(VARIANTS_DIR);
    const scenarios = readMeta(SCENARIOS_DIR);
    console.log('\nVariants:');
    variants.forEach((_, i) => console.log(printList(variants, i)));
    console.log('\nScenarios:');
    scenarios.forEach((_, i) => console.log(printList(scenarios, i)));
    process.exit(0);
  }

  const variants = readMeta(VARIANTS_DIR);
  const scenarios = readMeta(SCENARIOS_DIR);

  // Parse flags
  let variantName = '';
  const scenarioNames: string[] = [];
  let promote = args.includes('--promote');
  let skipBuild = args.includes('--skip-build');

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-v' || args[i] === '--variant') && args[i + 1]) {
      variantName = args[++i];
    } else if ((args[i] === '-s' || args[i] === '--scenario') && args[i + 1]) {
      scenarioNames.push(args[++i]);
    }
  }

  // Resolve by name
  let chosenVariant = variants.find((v) => v.name === variantName);
  let chosenScenarios = scenarioNames
    .map((n) => scenarios.find((s) => s.name === n))
    .filter((s): s is YamlMeta => !!s);

  // Interactive mode for missing args
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (!chosenVariant) {
      chosenVariant = await pick(rl, 'Select a variant:', variants);
    }

    if (chosenScenarios.length === 0) {
      chosenScenarios = await pickMulti(rl, 'Select scenario(s):', scenarios);
    }

    if (!promote) {
      promote = await confirm(rl, '\nPromote to production if all tests pass?');
    }

    if (!skipBuild) {
      skipBuild = await confirm(rl, 'Skip build (reuse already-pushed image)?');
    }
  } finally {
    rl.close();
  }

  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log(`Variant:   ${chosenVariant.name}`);
  console.log(`Scenarios: ${chosenScenarios.map((s) => s.name).join(', ')}`);
  console.log(`Promote:   ${promote ? 'yes' : 'no'}`);
  console.log(`Build:     ${skipBuild ? 'skip' : 'yes'}`);
  console.log('─'.repeat(50) + '\n');

  // Build runner args
  const runnerArgs = [
    RUNNER,
    '--variant', chosenVariant.file,
    ...chosenScenarios.flatMap((s) => ['--scenario', s.file]),
    ...(promote ? ['--promote'] : []),
    ...(skipBuild ? ['--skip-build'] : []),
  ];

  const result = spawnSync('npx', ['tsx', ...runnerArgs], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
