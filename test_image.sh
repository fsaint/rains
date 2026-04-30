#!/usr/bin/env bash
# Test a Docker image variant against Fly.io.
# Run with no arguments for interactive mode.
#
# Usage: ./test_image.sh [options]
#
# Options:
#   -v, --variant <name>    Variant to test (e.g. baseline, high-res-xvfb)
#   -s, --scenario <name>   Scenario to run (repeatable, e.g. -s ping -s basic-browser)
#   --promote               Write to promoted.yaml if all tests pass
#   --skip-build            Skip docker build (reuse previously pushed image)
#   --list                  List available variants and scenarios
#   --help                  Show this help
#
# Examples:
#   ./test_image.sh                                      # interactive
#   ./test_image.sh -v baseline -s ping                  # quick smoke test
#   ./test_image.sh -v baseline -s ping --skip-build     # reuse existing image
#   ./test_image.sh -v high-res-xvfb -s ping --promote   # test and promote
#   ./test_image.sh --list                               # show all options

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '/^# Usage/,/^[^#]/p' "$0" | grep "^#" | sed 's/^# *//'
  exit 0
fi

exec npx tsx "$SCRIPT_DIR/tests/image-test/cli.ts" "$@"
