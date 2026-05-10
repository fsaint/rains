#!/usr/bin/env bash
# run-sandbox-tests.sh — Integration test runner for Reins sandbox agents
#
# Tests all runtime×provider combinations against live Fly machines.
# Requires: fly CLI, curl, jq
#
# Usage:
#   ./scripts/run-sandbox-tests.sh [--app <fly-app-name>] [--machine <machine-id>]

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
FLY_APP="${FLY_APP:-}"
FLY_MACHINE="${FLY_MACHINE:-}"
MAX_HEALTH_WAIT=600   # seconds (10 min — OpenClaw can take ~9 min to reconnect)
HEALTH_POLL_INTERVAL=15

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

poll_health() {
  local app=$1
  local elapsed=0
  echo "Waiting for ${app} to become healthy (max ${MAX_HEALTH_WAIT}s)..."
  while [ "$elapsed" -lt "$MAX_HEALTH_WAIT" ]; do
    if curl -sf "https://${app}.fly.dev/health" > /dev/null 2>&1; then
      echo "  Machine healthy after ${elapsed}s"
      return 0
    fi
    sleep "$HEALTH_POLL_INTERVAL"
    elapsed=$((elapsed + HEALTH_POLL_INTERVAL))
  done
  echo "ERROR: Machine not healthy after ${MAX_HEALTH_WAIT}s" >&2
  return 1
}

restart_and_wait() {
  local app=$1
  local machine=$2
  echo "Restarting machine ${machine} on ${app}..."
  fly machine restart "$machine" --app "$app"
  poll_health "$app"
}

require_env() {
  local var=$1
  if [ -z "${!var:-}" ]; then
    echo "ERROR: ${var} is required. Set it or pass --${var,,} flag." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --app)       FLY_APP="$2"; shift 2 ;;
    --machine)   FLY_MACHINE="$2"; shift 2 ;;
    *)           echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

require_env FLY_APP

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo "=== Sandbox Integration Tests: ${FLY_APP} ==="

PASS=0
FAIL=0

run_test() {
  local name=$1
  local cmd=$2
  echo ""
  echo "--- ${name}"
  if eval "$cmd"; then
    echo "  PASS"
    PASS=$((PASS + 1))
  else
    echo "  FAIL"
    FAIL=$((FAIL + 1))
  fi
}

# Health check
run_test "health endpoint" \
  "curl -sf 'https://${FLY_APP}.fly.dev/health' | jq -e '.status == \"ok\"' > /dev/null"

# Restart and re-check (tests reconnect time)
if [ -n "$FLY_MACHINE" ]; then
  echo ""
  echo "--- restart + reconnect"
  restart_and_wait "$FLY_APP" "$FLY_MACHINE"
  run_test "health after restart" \
    "curl -sf 'https://${FLY_APP}.fly.dev/health' | jq -e '.status == \"ok\"' > /dev/null"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ]
