#!/bin/sh
set -e

mkdir -p /app/dist/plugins/runtime

# Find the gateway-cli file that contains createPluginRuntime
GATEWAY_CLI=""
for f in /app/dist/gateway-cli-*.js; do
  if grep -q "function createPluginRuntime" "$f" 2>/dev/null; then
    GATEWAY_CLI="$f"
    break
  fi
done

if [ -z "$GATEWAY_CLI" ]; then
  echo "WARNING: Could not find createPluginRuntime in any gateway-cli file"
  ls /app/dist/gateway-cli-*.js 2>/dev/null || echo "No gateway-cli files found"
  exit 0
fi

BASENAME=$(basename "$GATEWAY_CLI")

# Append an export statement to the gateway-cli bundle
printf '\nexport { createPluginRuntime };\n' >> "$GATEWAY_CLI"

# Create the shim that re-exports from the patched bundle
printf 'export { createPluginRuntime } from "../../%s";\n' "$BASENAME" > /app/dist/plugins/runtime/index.js

echo "Patched plugin runtime: $BASENAME"
cat /app/dist/plugins/runtime/index.js
