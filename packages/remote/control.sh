#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$ROOT/.runtime/node-v24.22.1-linux-x64/bin/node"
if [[ ! -x "$NODE" ]]; then NODE=node; fi
if [[ "${1:-}" == "ai" ]]; then
  shift
  exec "$NODE" "$ROOT/packages/lingxi-mcp/cli.mjs" ai "$@"
fi
exec "$NODE" "$ROOT/packages/lingxi-mcp/cli.mjs" shell "$@"
