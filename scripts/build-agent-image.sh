#!/usr/bin/env bash
# Build and deploy an agent Docker image.
# Copies the shared agent docs into the runtime's build context before deploying,
# resolving {{tool:NAME}} tokens to the tool names that runtime's model sees.
#
# Usage: scripts/build-agent-image.sh <openclaw|hermes|openclaw-dev|hermes-dev>
# Must be run from the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared docs baked into every agent image. Kept in shared/ so both runtimes
# stay in sync; tool names inside them are runtime-specific and resolved below.
SHARED_DOCS=(BOOTSTRAP.md MEMORY_POLICY.md)

# Render {{tool:NAME}} into the name the model actually sees.
#
#   OpenClaw  <server>__<tool>        -> helm__mark_onboarded
#   Hermes    mcp__<server>__<tool>   -> mcp__helm__mark_onboarded
#
# These files are read straight off the container filesystem, so unlike
# MCP-served skills there is no serve-time substitution to fall back on — the
# name has to be correct at build time or the model cannot call the tool.
# Keep in sync with shared/src/mcp-naming.ts.
render_docs() {
  local engine="$1" dest_dir="$2" replacement doc
  case "$engine" in
    openclaw) replacement='helm__\1' ;;
    hermes)   replacement='mcp__helm__\1' ;;
    *) echo "render_docs: unknown engine $engine" >&2; exit 1 ;;
  esac

  for doc in "${SHARED_DOCS[@]}"; do
    sed -E "s/\{\{tool:([A-Za-z0-9_]+)\}\}/${replacement}/g" \
      "$REPO_ROOT/shared/$doc" > "$dest_dir/$doc"
    echo "[build] Rendered shared/$doc → ${dest_dir#"$REPO_ROOT/"}/$doc ($engine tool names)"
  done
}

runtime="${1:?Usage: $0 <openclaw|hermes|openclaw-dev|hermes-dev>}"

case "$runtime" in
  openclaw)
    render_docs openclaw "$REPO_ROOT/docker/workspace"
    cd "$REPO_ROOT/docker"
    fly deploy
    ;;
  openclaw-dev)
    render_docs openclaw "$REPO_ROOT/docker/workspace"
    cd "$REPO_ROOT/docker"
    fly deploy --config fly.dev.toml
    ;;
  hermes)
    render_docs hermes "$REPO_ROOT/docker/hermes"
    cd "$REPO_ROOT/docker/hermes"
    fly deploy
    ;;
  hermes-dev)
    render_docs hermes "$REPO_ROOT/docker/hermes"
    cd "$REPO_ROOT/docker/hermes"
    fly deploy --config fly.dev.toml
    ;;
  *)
    echo "Unknown runtime: $runtime (expected openclaw|hermes|openclaw-dev|hermes-dev)" >&2
    exit 1
    ;;
esac
