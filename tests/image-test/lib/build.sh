#!/usr/bin/env bash
# Build a Dockerfile variant and push to Fly registry.
# Usage: build.sh <variant-yaml-path> [--skip-push]
#
# Reads build_args from the YAML and passes them as --build-arg flags.
# Tags the image as registry.fly.io/reins-imgtest:<variant-name>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DOCKER_DIR="$REPO_ROOT/docker"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <variant-yaml> [--skip-push]" >&2
  exit 1
fi

VARIANT_YAML="$1"
SKIP_PUSH="${2:-}"

if [ ! -f "$VARIANT_YAML" ]; then
  echo "Error: variant file not found: $VARIANT_YAML" >&2
  exit 1
fi

# Parse variant YAML using Node.js (always available in dev environment)
VARIANT_JSON=$(node -e "
const fs = require('fs');
const yaml = fs.readFileSync('$VARIANT_YAML', 'utf8');
// Simple YAML parser for our flat structure
const lines = yaml.split('\n');
const result = { name: '', build_args: {} };
let inBuildArgs = false;
for (const line of lines) {
  if (line.startsWith('name:')) {
    result.name = line.split(':')[1].trim().replace(/['\"]*/g, '');
  } else if (line.startsWith('build_args:')) {
    inBuildArgs = true;
  } else if (inBuildArgs && line.match(/^  \w/)) {
    const m = line.match(/^  (\w+):\s*['\"]?(.*?)['\"]?\s*$/);
    if (m) result.build_args[m[1]] = m[2];
  } else if (line.match(/^\w/) && !line.startsWith('build_args:')) {
    inBuildArgs = false;
  }
}
console.log(JSON.stringify(result));
")

VARIANT_NAME=$(echo "$VARIANT_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).name)")
IMAGE_TAG="registry.fly.io/reins-imgtest:$VARIANT_NAME"

echo "Building variant: $VARIANT_NAME"
echo "Image tag: $IMAGE_TAG"
echo ""

# Build --build-arg flags from YAML build_args
BUILD_ARGS=$(echo "$VARIANT_JSON" | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const args = Object.entries(data.build_args)
  .map(([k, v]) => \`--build-arg \${k}=\${v}\`)
  .join(' ');
process.stdout.write(args);
")

echo "Build args: $BUILD_ARGS"
echo ""

# Run docker build from the docker/ directory (always target linux/amd64 for Fly.io)
# shellcheck disable=SC2086
docker build \
  --platform linux/amd64 \
  -f "$DOCKER_DIR/Dockerfile" \
  -t "$IMAGE_TAG" \
  $BUILD_ARGS \
  "$DOCKER_DIR"

echo ""
echo "Build complete: $IMAGE_TAG"

if [ "$SKIP_PUSH" = "--skip-push" ]; then
  echo "Skipping push (--skip-push flag set)"
  exit 0
fi

echo "Authenticating with Fly registry..."
flyctl auth docker

echo "Pushing $IMAGE_TAG..."
docker push "$IMAGE_TAG"

echo ""
echo "Done: $IMAGE_TAG pushed to Fly registry"
