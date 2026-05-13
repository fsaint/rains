#!/usr/bin/env bash
# Build and deploy an agent Docker image.
# Copies the shared BOOTSTRAP.md into the runtime's build context before deploying.
#
# Usage: scripts/build-agent-image.sh <openclaw|hermes>
# Must be run from the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

runtime="${1:?Usage: $0 <openclaw|hermes>}"

case "$runtime" in
  openclaw)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/workspace/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/workspace/BOOTSTRAP.md"
    cd "$REPO_ROOT/docker"
    fly deploy
    ;;
  hermes)
    cp "$REPO_ROOT/shared/BOOTSTRAP.md" "$REPO_ROOT/docker/hermes/BOOTSTRAP.md"
    echo "[build] Copied shared/BOOTSTRAP.md → docker/hermes/BOOTSTRAP.md"
    cd "$REPO_ROOT/docker/hermes"
    fly deploy
    ;;
  *)
    echo "Unknown runtime: $runtime (expected openclaw or hermes)" >&2
    exit 1
    ;;
esac
