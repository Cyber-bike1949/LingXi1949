#!/usr/bin/env bash
set -euo pipefail
VERSION="${LINGXI_REMOTE_VERSION:-5.0.4}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid LINGXI_REMOTE_VERSION' >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo '仅支持 Linux x64；Windows 请使用 install-remote.ps1。' >&2; exit 1; }
for tool in curl tar sha256sum mktemp xz; do
  command -v "$tool" >/dev/null || { echo "请先安装 $tool" >&2; exit 1; }
done
BASE="${LINGXI_REMOTE_HOME:-$HOME/.local/share/lingxi-remote}"
mkdir -p "$BASE"
BASE="$(cd -- "$BASE" && pwd -P)"
DEST="$BASE/$VERSION"
LOCK="$BASE/$VERSION.lock"
mkdir "$LOCK" 2>/dev/null || { echo "安装正在进行；如已中断，请移除 $LOCK 后重试。" >&2; exit 1; }
STAGE=''
cleanup() {
  [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
  rmdir -- "$LOCK"
}
trap cleanup EXIT
if [[ ! -e "$DEST" ]]; then
  STAGE="$(mktemp -d "$BASE/.download.XXXXXXXX")"
  ASSET="lingxi-remote-$VERSION-linux-x64.tar.gz"
  URL="https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-$VERSION"
  echo "正在下载 LingXi Remote $VERSION…"
  for file in "$ASSET" "$ASSET.sha256"; do
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fSL --retry 2 --connect-timeout 20 --max-time 600 "$URL/$file" -o "$STAGE/$file" || {
      echo "下载失败。请确认 remote-$VERSION 已公开发布且包含 $file：https://github.com/Cyber-bike1949/LingXi1949/releases" >&2
      exit 1
    }
  done
  read -r EXPECTED NAME < "$STAGE/$ASSET.sha256"
  [[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ && "$NAME" == "$ASSET" ]] || { echo 'Invalid checksum file' >&2; exit 1; }
  printf '%s  %s\n' "$EXPECTED" "$ASSET" | (cd "$STAGE" && sha256sum -c -)
  mkdir "$STAGE/package"
  tar -xzf "$STAGE/$ASSET" -C "$STAGE/package"
  [[ -f "$STAGE/package/scripts/setup.sh" && -f "$STAGE/package/scripts/setup.mjs" && -f "$STAGE/package/bin/lingxi1949" ]] || { echo 'Incomplete platform package' >&2; exit 1; }
  printf '%s\n' "$EXPECTED" > "$STAGE/package/.lingxi-installed"
  mv -T -- "$STAGE/package" "$DEST"
elif [[ ! -f "$DEST/.lingxi-installed" || ! -f "$DEST/scripts/setup.sh" || ! -f "$DEST/scripts/setup.mjs" || ! -f "$DEST/bin/lingxi1949" ]]; then
  echo "目录 $DEST 已存在但不是此脚本安装的完整包；请设置 LINGXI_REMOTE_HOME 为其他目录。" >&2
  exit 1
fi
# Repair only the published 5.0.0 startup files; preserve identity and configuration.
if [[ "$VERSION" == 5.0.0 ]]; then
  FIX_URL="https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/packages/remote"
  while read -r HASH FILE; do
    if [[ -f "$DEST/$FILE" ]] && printf '%s  %s\n' "$HASH" "$DEST/$FILE" | sha256sum -c - >/dev/null 2>&1; then continue; fi
    [[ -n "$STAGE" ]] || STAGE="$(mktemp -d "$BASE/.repair.XXXXXXXX")"
    PATCH="$STAGE/$(basename "$FILE").fixed"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 20 --max-time 120 "$FIX_URL/$FILE" -o "$PATCH"
    printf '%s  %s\n' "$HASH" "$PATCH" | sha256sum -c -
    mv -f -- "$PATCH" "$DEST/$FILE"
  done <<'LINGXI_FIXES'
eb6e6d5b4803c063e91d887dbf27859da0e205b94d7e2624fc610a2cad29559a package-lock.json
af91aada3fcb31985cdce0a607f6ad39d754bc339ded986762a72be4745a5f90 scripts/setup.sh
745548a7c7203658ba4e05c4e7f9f0a93beb2b1a820ac2b4604b2d8fc1ef934a control.sh
e388a20ba975ab81ef8a7d83c42f48c0f652042634e235b3800fd08fd2d0b5a8 packages/lingxi-mcp/cli.mjs
c3658b2d1a0faf1ba9bdf862e1738b9235c690396a964f427ac78a4551822d63 packages/lingxi-mcp/strict-ai.mjs
30a738482add2281aad9c095bdd70b1d26cd5dba9543bf8ba8301e900f8082ec packages/lingxi-mcp/ai-bridge.mjs
e8a9f261238f46515ce07efb85dab98df7d2db73e271e4b4634552e09d3d4bd0 packages/lingxi-mcp/mcp-socket-proxy.mjs
LINGXI_FIXES
  chmod +x "$DEST/control.sh" "$DEST/scripts/setup.sh"
fi
echo "安装目录：$DEST"
printf '日常手动控制：bash %q\n' "$DEST/control.sh"
# Run from a file, preserving stdin for the interactive setup wizard.
bash "$DEST/scripts/setup.sh" "$@"
