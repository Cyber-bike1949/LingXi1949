#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$ROOT/.runtime/node-v24.22.1-linux-x64/bin/node"
if [[ ! -x "$NODE" ]]; then NODE=node; fi
if [[ "${1:-}" == "ai" || "${1:-}" == "codex" || "${1:-}" == "claude" ]]; then
  COMMAND="$1"
  shift
  exec "$NODE" "$ROOT/packages/lingxi-mcp/cli.mjs" "$COMMAND" "$@"
fi
exec "$NODE" "$ROOT/packages/lingxi-mcp/cli.mjs" shell "$@"
