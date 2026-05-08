---
name: image-test
description: Build and test Docker image variants against the Fly.io test org. Use when the user asks to "test the image", "test browser", "run image test", "image test", or "verify the browser stack works".
---

# Image Test

Tests Docker image variants by deploying ephemeral Fly machines and exercising browser capabilities via Telegram.

## Architecture

```
Build variant image → Push to Fly registry → Create ephemeral machine →
Send Telegram prompt → Assert on reply/screenshots → Tear down machine
```

## Prerequisites

- `tests/image-test/.env.image-test` exists with all required keys (see `.env.image-test.example`)
- Docker is running
- `flyctl` is authenticated (`fly auth whoami`)
- `python3` with `telethon` installed (`pip3 install telethon`)
- Telethon session exists (run once interactively if not):
  ```bash
  cd tests/image-test
  source .env.image-test
  python3 -c "
  from telethon.sync import TelegramClient
  import os
  with TelegramClient(os.environ['TELETHON_SESSION'], int(os.environ['TELETHON_API_ID']), os.environ['TELETHON_API_HASH']) as c:
      c.start(phone=os.environ['TELEGRAM_PHONE'])
      print('Session created')
  "
  ```

## Variants

| Variant | Description |
|---------|-------------|
| `baseline` | Current production config (1280x1024x24) |
| `high-res-xvfb` | Higher resolution (1920x1080x24) + extra fonts |

## Scenarios

| Scenario | Description | Timeout |
|----------|-------------|---------|
| `basic-browser` | Load example.com, read h1 heading | 120s |
| `opentable-search` | Search OpenTable, capture restaurant + screenshot | 180s |

## Running Tests

### Single scenario against baseline

```bash
npx tsx tests/image-test/lib/runner.ts \
  --variant tests/image-test/variants/baseline.yaml \
  --scenario tests/image-test/scenarios/basic-browser.yaml
```

### Multiple scenarios

```bash
npx tsx tests/image-test/lib/runner.ts \
  --variant tests/image-test/variants/baseline.yaml \
  --scenario tests/image-test/scenarios/basic-browser.yaml \
  --scenario tests/image-test/scenarios/opentable-search.yaml
```

### Skip rebuild (reuse previously pushed image)

```bash
npx tsx tests/image-test/lib/runner.ts \
  --variant tests/image-test/variants/high-res-xvfb.yaml \
  --scenario tests/image-test/scenarios/basic-browser.yaml \
  --skip-build
```

### Compare both variants

```bash
for variant in baseline high-res-xvfb; do
  npx tsx tests/image-test/lib/runner.ts \
    --variant "tests/image-test/variants/${variant}.yaml" \
    --scenario tests/image-test/scenarios/basic-browser.yaml \
    --scenario tests/image-test/scenarios/opentable-search.yaml
done
```

## Procedure

1. Ask the user which variant(s) to test: `baseline`, `high-res-xvfb`, or both
2. Ask which scenario(s): `basic-browser`, `opentable-search`, or both
3. Confirm `.env.image-test` exists; if not, ask user to copy from `.env.image-test.example`
4. Run the runner command
5. Report pass/fail with assertion details
6. Save results to `tests/image-test/results/<timestamp>/`

## Results

Results are saved as timestamped directories in `tests/image-test/results/` (gitignored):

```
tests/image-test/results/
  2026-04-29T12-00-00-baseline/
    summary.json          # pass/fail + assertion details
    screenshot_*.jpg      # any captured screenshots
```

## Adding New Variants

Create a YAML file in `tests/image-test/variants/`:

```yaml
name: my-variant
description: What this variant tests
build_args:
  XVFB_RESOLUTION: "1920x1080x24"
  EXTRA_FONT_PACKAGES: "fonts-dejavu-core"
```

## Adding New Scenarios

Create a YAML file in `tests/image-test/scenarios/`:

```yaml
name: my-scenario
description: What this scenario tests
timeout_seconds: 120
prompt: |
  Your instruction to the agent here.
  Can be multi-line.
assertions:
  - type: reply_contains
    value: "expected text"
  - type: reply_not_contains
    values: ["error", "failed"]
  - type: screenshot_present
  - type: reply_min_length
    value: 50
```

Supported assertion types: `reply_contains`, `reply_contains_any`, `reply_not_contains`, `screenshot_present`, `reply_min_length`.

## Fly Org Setup (one-time)

```bash
# Create the test org (if it doesn't exist)
fly orgs create reins-test

# Create the image registry app (only once)
fly apps create reins-imgtest --org reins-test

# Get an API token with access to reins-test org
fly tokens create org --org reins-test
# Add to .env.image-test as FLY_API_TOKEN
```

## Teardown Verification

After each run, verify cleanup:

```bash
fly apps list -o reins-test
# Should show no reins-imgtest-* apps (all were destroyed)
```
