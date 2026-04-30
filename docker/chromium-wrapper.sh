#!/bin/bash
# Chromium wrapper — injects extra launch flags for complex pages like OpenTable.
#
# Flags added here that OpenClaw does NOT pass by default:
#
#   --disable-blink-features=AutomationControlled
#       Removes navigator.webdriver=true which many anti-bot systems (Akamai,
#       DataDome) use to fingerprint and block headless browsers. Without this
#       flag, OpenTable and similar sites return ERR_HTTP2_PROTOCOL_ERROR or
#       silently drop the connection.
#
# Flags already passed by OpenClaw internally (no-op if duplicated here):
#   --disable-dev-shm-usage, --disable-gpu, --no-sandbox
#
# Discovers the real Chromium binary from Playwright's cache at runtime so
# this wrapper is not sensitive to Playwright version changes in the image.

REAL=$(ls /home/node/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)

if [ -z "${REAL}" ]; then
  echo "[chromium-wrapper] ERROR: could not find Chromium binary in Playwright cache" >&2
  exit 1
fi

exec "${REAL}" "$@"
