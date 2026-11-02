#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
npm ci --prefix e2e/obsidian --ignore-scripts --no-audit --no-fund
node e2e/obsidian/run.mjs "$@"
