#!/usr/bin/env bash
# Build a Dockerfile variant and push to Fly registry using remote builder.
# Usage: build.sh <variant-yaml-path>
#
# No local Docker required — images are built on Fly.io infrastructure.
# Tags the image as registry.fly.io/reins-imgtest:<variant-name>
#
# Strategy: fly deploy --build-only doesn't push to the persistent registry.
# We do a real deploy to push the image, then immediately stop the machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Load .env.image-test if FLY_API_TOKEN isn't already set
ENV_FILE="$SCRIPT_DIR/../.env.image-test"
if [ -z "${FLY_API_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <variant-yaml>" >&2
  exit 1
fi

VARIANT_YAML="$1"

if [ ! -f "$VARIANT_YAML" ]; then
  echo "Error: variant file not found: $VARIANT_YAML" >&2
  exit 1
fi

# Parse variant YAML using Node.js
VARIANT_JSON=$(node -e "
const fs = require('fs');
const yaml = fs.readFileSync('$VARIANT_YAML', 'utf8');
const lines = yaml.split('\n');
const result = { name: '', dockerfile: '', build_args: {} };
let inBuildArgs = false;
for (const line of lines) {
  if (line.startsWith('name:')) {
    result.name = line.split(':')[1].trim().replace(/['\"]*/g, '');
  } else if (line.startsWith('dockerfile:')) {
    result.dockerfile = line.split(':').slice(1).join(':').trim().replace(/['\"]*/g, '');
  } else if (line.startsWith('build_args:')) {
    inBuildArgs = true;
  } else if (inBuildArgs && line.match(/^  \w/)) {
    const m = line.match(/^  (\w+):\s*['\"]?(.*?)['\"]?\s*$/);
    if (m) result.build_args[m[1]] = m[2];
  } else if (line.match(/^\w/) && !line.startsWith('build_args:')) {
    inBuildArgs = false;
  }
}
// Default to openclaw dockerfile if not specified
if (!result.dockerfile) result.dockerfile = 'docker/Dockerfile';
console.log(JSON.stringify(result));
")

VARIANT_NAME=$(echo "$VARIANT_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).name)")
DOCKERFILE=$(echo "$VARIANT_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).dockerfile)")
IMAGE_TAG="registry.fly.io/reins-imgtest:$VARIANT_NAME"

echo "Building variant: $VARIANT_NAME"
echo "Dockerfile:       $DOCKERFILE"
echo "Image tag:        $IMAGE_TAG"
echo ""

# Build --build-arg flags from YAML build_args
BUILD_ARGS=$(echo "$VARIANT_JSON" | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const args = Object.entries(data.build_args)
  .filter(([, v]) => v !== '')
  .map(([k, v]) => \`--build-arg \${k}=\${v}\`)
  .join(' ');
process.stdout.write(args);
")

if [ -n "$BUILD_ARGS" ]; then
  echo "Build args: $BUILD_ARGS"
  echo ""
fi

DOCKERFILE_ABS="$REPO_ROOT/$DOCKERFILE"
BUILD_CONTEXT="$(dirname "$DOCKERFILE_ABS")"

# Write a minimal fly.toml for the reins-imgtest registry app.
# Using a temp file so we don't touch the real fly.toml files.
TMPDIR_FLY=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FLY"' EXIT

cat > "$TMPDIR_FLY/fly.toml" <<TOML
app = "reins-imgtest"
primary_region = "iad"

[http_service]
  internal_port = 3000
  auto_stop_machines = "stop"
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
TOML

echo "Building and pushing to Fly.io registry (no local Docker required)..."

# Deploy to push the image to the registry. Immediately scale to 0 after.
# shellcheck disable=SC2086
FLY_API_TOKEN="$FLY_API_TOKEN" \
flyctl deploy \
  --remote-only \
  --app reins-imgtest \
  --dockerfile "$DOCKERFILE_ABS" \
  --image-label "$VARIANT_NAME" \
  --ha=false \
  $BUILD_ARGS \
  --config "$TMPDIR_FLY/fly.toml" \
  "$BUILD_CONTEXT"

echo ""
echo "Stopping registry machine (image is now in registry)..."
FLY_API_TOKEN="$FLY_API_TOKEN" \
flyctl scale count 0 --app reins-imgtest --yes 2>/dev/null || true

echo ""
echo "Done: $IMAGE_TAG pushed to Fly registry"
