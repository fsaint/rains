#!/usr/bin/env bash
# Build and deploy an agent Docker image.
# Copies the shared BOOTSTRAP.md into the runtime's build context before deploying.
#
# Usage: scripts/build-agent-image.sh <openclaw|hermes>
# Must be run from the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

runtime="${1:?Usage: $0 <openclaw|hermes|openclaw-dev|hermes-dev>}"

case "$runtime" in
  openclaw)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/workspace/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/workspace/BOOTSTRAP.md"
    cp "$REPO_ROOT/shared/MEMORY_POLICY.md" "$REPO_ROOT/docker/workspace/MEMORY_POLICY.md"
    echo "[build] Copied shared/MEMORY_POLICY.md → docker/workspace/MEMORY_POLICY.md"
    cd "$REPO_ROOT/docker"
    fly deploy
    ;;
  openclaw-dev)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/workspace/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/workspace/BOOTSTRAP.md"
    cp "$REPO_ROOT/shared/MEMORY_POLICY.md" "$REPO_ROOT/docker/workspace/MEMORY_POLICY.md"
    echo "[build] Copied shared/MEMORY_POLICY.md → docker/workspace/MEMORY_POLICY.md"
    cd "$REPO_ROOT/docker"
    fly deploy --config fly.dev.toml
    ;;
  hermes)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/hermes/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/hermes/BOOTSTRAP.md"
    cp "$REPO_ROOT/shared/MEMORY_POLICY.md" "$REPO_ROOT/docker/hermes/MEMORY_POLICY.md"
    echo "[build] Copied shared/MEMORY_POLICY.md → docker/hermes/MEMORY_POLICY.md"
    cd "$REPO_ROOT/docker/hermes"
    fly deploy
    ;;
  hermes-dev)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/hermes/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/hermes/BOOTSTRAP.md"
    cp "$REPO_ROOT/shared/MEMORY_POLICY.md" "$REPO_ROOT/docker/hermes/MEMORY_POLICY.md"
    echo "[build] Copied shared/MEMORY_POLICY.md → docker/hermes/MEMORY_POLICY.md"
    cd "$REPO_ROOT/docker/hermes"
    fly deploy --config fly.dev.toml
    ;;
  *)
    echo "Unknown runtime: $runtime (expected openclaw|hermes|openclaw-dev|hermes-dev)" >&2
    exit 1
    ;;
esac
