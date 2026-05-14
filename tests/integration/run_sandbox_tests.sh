#!/usr/bin/env bash
# Sandbox permission test orchestrator for Reins integration tests.
#
# Sources into the calling shell and provides the sandbox_tests function.
#
# Usage:
#   source tests/integration/run_sandbox_tests.sh
#   sandbox_tests <bot_username> <agent_id> [env_file]
#
# env_file defaults to tests/integration/.env.test

# Resolve script directory — works when sourced in both bash and zsh
if [[ -n "${ZSH_VERSION:-}" ]]; then
  _SANDBOX_SCRIPT_DIR="$(cd "$(dirname "${(%):-%x}")" && pwd)"
elif [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  _SANDBOX_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  _SANDBOX_SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

sandbox_tests() {
    local BOT_USERNAME="$1"
    local AGENT_ID="$2"
    local ENV_FILE="${3:-$_SANDBOX_SCRIPT_DIR/.env.test}"

    if [[ -z "$BOT_USERNAME" || -z "$AGENT_ID" ]]; then
        echo "Usage: sandbox_tests <bot_username> <agent_id> [env_file]" >&2
        return 1
    fi

    # shellcheck disable=SC1090
    source "$ENV_FILE"

    local PASS=0
    local FAIL=0
    local COOKIES=/tmp/reins_test_cookies.txt

    echo "=== Sandbox Tests: $BOT_USERNAME / $AGENT_ID ==="
    echo "    env: $ENV_FILE"
    echo ""

    # ── Admin login ──────────────────────────────────────────────────────────
    curl -s -c "$COOKIES" -X POST "$REINS_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$REINS_ADMIN_EMAIL\",\"password\":\"$REINS_ADMIN_PASSWORD\"}" \
        > /dev/null

    # ── Enable dev-sandbox ───────────────────────────────────────────────────
    echo "Enabling dev-sandbox (access=true, level=full)..."
    curl -s -b "$COOKIES" -X PUT "$REINS_URL/api/permissions/$AGENT_ID/dev-sandbox/access" \
        -H "Content-Type: application/json" \
        -d '{"enabled":true}' > /dev/null
    curl -s -b "$COOKIES" -X PUT "$REINS_URL/api/permissions/$AGENT_ID/dev-sandbox/level" \
        -H "Content-Type: application/json" \
        -d '{"level":"full"}' > /dev/null

    # ── Restart machine so OpenClaw picks up new tools ───────────────────────
    echo "Restarting agent machine..."
    curl -s -b "$COOKIES" -X POST "$REINS_URL/api/agents/$AGENT_ID/restart" \
        -H "Content-Type: application/json" > /dev/null

    echo "Waiting 20s for machine restart and Telegram reconnect..."
    sleep 20

    local _TG_ENV=(
        "TELEGRAM_API_ID=$TELEGRAM_API_ID"
        "TELEGRAM_API_HASH=$TELEGRAM_API_HASH"
        "TELEGRAM_PHONE=$TELEGRAM_PHONE"
        "REINS_URL=$REINS_URL"
        "REINS_ADMIN_EMAIL=$REINS_ADMIN_EMAIL"
        "REINS_ADMIN_PASSWORD=$REINS_ADMIN_PASSWORD"
    )

    local _TOOL_SCRIPT="$_SANDBOX_SCRIPT_DIR/tg_mcp_tool_test.py"

    # ── Scenario 1: ALLOWED — sandbox_echo ──────────────────────────────────
    echo ""
    echo "--- [1/4] ALLOWED (sandbox_echo) ---"
    local RESULT
    RESULT=$(env "${_TG_ENV[@]}" python3 "$_TOOL_SCRIPT" \
        "$BOT_USERNAME" "$AGENT_ID" \
        "Call the sandbox_echo tool with message ping-allowed. Report the tool result." \
        none 90)
    if echo "$RESULT" | grep -qi "ping-allowed"; then
        echo "PASS: $RESULT"
        PASS=$((PASS+1))
    else
        echo "FAIL: $RESULT"
        FAIL=$((FAIL+1))
    fi

    # ── Scenario 2: APPROVE — sandbox_send_message ───────────────────────────
    echo ""
    echo "--- [2/4] APPROVE (sandbox_send_message) ---"
    RESULT=$(env "${_TG_ENV[@]}" python3 "$_TOOL_SCRIPT" \
        "$BOT_USERNAME" "$AGENT_ID" \
        "Call sandbox_send_message: to=ops@reins.io, subject=approve-test, body=please approve. Report result." \
        approve 120)
    if echo "$RESULT" | grep -qiE "sent|delivered|success|approved|confirm|message.*sent"; then
        echo "PASS: $RESULT"
        PASS=$((PASS+1))
    else
        echo "FAIL: $RESULT"
        FAIL=$((FAIL+1))
    fi

    # ── Scenario 3: DENY — sandbox_send_message ──────────────────────────────
    echo ""
    echo "--- [3/4] DENY (sandbox_send_message) ---"
    RESULT=$(env "${_TG_ENV[@]}" python3 "$_TOOL_SCRIPT" \
        "$BOT_USERNAME" "$AGENT_ID" \
        "Call sandbox_send_message: to=ops@reins.io, subject=deny-test, body=denied. Report what happened." \
        reject 120)
    if echo "$RESULT" | grep -qiE "denied|rejected|not allowed|declined|blocked|wasn.t|could not|cannot|did not|didn.t|request.*denied"; then
        echo "PASS: $RESULT"
        PASS=$((PASS+1))
    else
        echo "FAIL: $RESULT"
        FAIL=$((FAIL+1))
    fi

    # ── Scenario 4: BLOCKED — sandbox_delete_item ────────────────────────────
    echo ""
    echo "--- [4/4] BLOCKED (sandbox_delete_item) ---"
    RESULT=$(env "${_TG_ENV[@]}" python3 "$_TOOL_SCRIPT" \
        "$BOT_USERNAME" "$AGENT_ID" \
        "Call ONLY the sandbox_delete_item tool to delete item-1. Do NOT call any other tool. If sandbox_delete_item is not in your toolset, say so explicitly." \
        none 90)
    if echo "$RESULT" | grep -qiE "not available|not in|don.t have|cannot|unavailable|doesn.t exist|no tool|not a tool|do not have access|not accessible|unable"; then
        echo "PASS: $RESULT"
        PASS=$((PASS+1))
    else
        echo "FAIL: $RESULT"
        FAIL=$((FAIL+1))
    fi

    echo ""
    echo "=== Results: $PASS/4 passed, $FAIL/4 failed ==="
    [[ $FAIL -eq 0 ]]
}
