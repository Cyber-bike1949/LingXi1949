#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo '当前支持 Linux x64；Windows 请用 setup.ps1' >&2; exit 1; }
VERSION=v24.22.1
RUNTIME="$ROOT/.runtime"
if ! command -v node >/dev/null || ! node -e 'if(+process.versions.node.split(".")[0]<24)process.exit(1)' || ! command -v npm >/dev/null; then
  mkdir -p "$RUNTIME"
  if [[ ! -x "$RUNTIME/node-$VERSION-linux-x64/bin/node" ]]; then
    STAGE="$(mktemp -d "$RUNTIME/download.XXXXXXXX")"
    trap 'rm -rf -- "$STAGE"' EXIT
    ASSET="node-$VERSION-linux-x64.tar.xz"
    BASE="https://nodejs.org/dist/$VERSION"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 300 "$BASE/$ASSET" -o "$STAGE/$ASSET"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 "$BASE/SHASUMS256.txt" -o "$STAGE/SHASUMS256.txt"
    (cd "$STAGE" && grep "  $ASSET$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$STAGE/$ASSET" -C "$RUNTIME"
  fi
  export PATH="$RUNTIME/node-$VERSION-linux-x64/bin:$PATH"
fi
cd "$ROOT"
if [[ ! -d node_modules/@number0/iroh ]]; then npm ci --omit=dev --ignore-scripts --no-audit --no-fund; fi
exec node scripts/setup.mjs "$@"
