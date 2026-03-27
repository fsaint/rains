#!/bin/bash
set -e

IMAGE="reins-openclaw:latest"
ANTHROPIC_KEY="${ANTHROPIC_API_KEY}"

usage() {
  echo "Usage:"
  echo "  $0 run <name> <telegram-token> [mcp-json]   Start a new container"
  echo "  $0 ls                                        List containers"
  echo "  $0 rm <name>                                 Delete a container"
  echo "  $0 logs <name>                               Tail logs"
  echo ""
  echo "Examples:"
  echo "  $0 run test1 '123:ABC'"
  echo "  $0 run test2 '123:ABC' '[{\"name\":\"fs\",\"command\":\"node\",\"args\":[\"/srv/fs.js\"]}]'"
  echo "  $0 logs test1"
  echo "  $0 rm test1"
  exit 1
}

cmd_run() {
  local name="$1"
  local token="$2"
  local mcp="${3:-[]}"

  if [ -z "$name" ] || [ -z "$token" ]; then
    echo "Error: name and telegram-token required"
    usage
  fi

  # Stop existing container with same name if any
  docker rm -f "reins-$name" 2>/dev/null || true

  echo "Starting reins-$name..."
  docker run -d \
    --name "reins-$name" \
    -e TELEGRAM_BOT_TOKEN="$token" \
    -e MCP_CONFIG="$mcp" \
    -e ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
    -e OPENCLAW_NO_RESPAWN=1 \
    -e NODE_OPTIONS="--max-old-space-size=3072 --dns-result-order=ipv4first" \
    -p "0:18789" \
    "$IMAGE"

  local port=$(docker port "reins-$name" 18789 2>/dev/null | head -1 | cut -d: -f2)
  echo "Container: reins-$name"
  echo "Gateway:   http://localhost:$port"
  echo "Logs:      $0 logs $name"
}

cmd_ls() {
  echo "CONTAINER           STATUS              PORTS"
  docker ps -a --filter "name=reins-" --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null | column -t -s $'\t'
}

cmd_rm() {
  local name="$1"
  if [ -z "$name" ]; then
    echo "Error: name required"
    usage
  fi
  # Accept both "test1" and "reins-test1"
  local cname="$name"
  [[ "$name" != reins-* ]] && cname="reins-$name"
  docker rm -f "$cname" 2>/dev/null && echo "Removed $cname" || echo "Not found: $cname"
}

cmd_logs() {
  local name="$1"
  if [ -z "$name" ]; then
    echo "Error: name required"
    usage
  fi
  local cname="$name"
  [[ "$name" != reins-* ]] && cname="reins-$name"
  docker logs -f "$cname"
}

case "${1:-}" in
  run)  cmd_run "$2" "$3" "$4" ;;
  ls)   cmd_ls ;;
  rm)   cmd_rm "$2" ;;
  logs) cmd_logs "$2" ;;
  *)    usage ;;
esac
