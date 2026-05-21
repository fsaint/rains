#!/usr/bin/env bash
# Pre-flight check: refuse to proceed if the local .env has FLY_ORG=personal.
# Run before any local dev session to catch accidental production-org config.
#
# Usage: scripts/check-local-env.sh

set -e

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE found — skipping check."
  exit 0
fi

if grep -qE '^FLY_ORG=personal\s*$' "$ENV_FILE"; then
  echo ""
  echo "⛔  ERROR: $ENV_FILE contains FLY_ORG=personal"
  echo ""
  echo "   Local development MUST use a dev org (e.g. reins-dev)."
  echo "   The personal-org token lives only in production Fly secrets."
  echo ""
  echo "   Fix: change FLY_ORG=personal to FLY_ORG=reins-dev in $ENV_FILE"
  echo ""
  exit 1
fi

echo "✓ $ENV_FILE looks safe (FLY_ORG is not 'personal')"
exit 0
