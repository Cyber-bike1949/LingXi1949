# LingXi Remote 5.0

远程设备子包：控制端终端、被控制端 Agent、Codex/Claude MCP 接入。Obsidian 插件在本仓库的 `packages/obsidian-plugin`，共同协议在本仓库的 `packages/core`。无须运行 Obsidian 即可使用本项目。

## 首次使用

在控制端和被控制端各复制执行一次下面的命令。`install-remote` 自动下载对应平台包、校验 SHA-256、解压并启动初始化；无需手动下载解压，也无需先安装 Node.js、pnpm 或 Rust。

> 安装版本：[Remote 5.0.0](https://github.com/Cyber-bike1949/LingXi1949/releases/tag/remote-5.0.0)，支持 Linux x64 和 Windows x64。下方命令从该版本的公开 Release 下载对应平台包，不会下载旧版插件包。

**Linux x64**，在终端粘贴执行整个代码块（需要系统自带或预先安装 `curl`、`tar`、`sha256sum`、`xz`）：

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f -- "$installer"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/packages/remote/scripts/install-remote.sh -o "$installer"
  bash "$installer"
)
```

**Windows x64**，在 PowerShell 粘贴执行整个代码块（需要系统自带的 `tar.exe`）：

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $installer = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.ps1')
  try {
    Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/packages/remote/scripts/install-remote.ps1 -OutFile $installer
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE -ne 0) { throw '安装未完成，请查看上方错误后重试。' }
  } finally { Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue }
}
```

脚本名称是 `install-remote.sh` / `install-remote.ps1`。下载脚本后再执行，保留终端输入给初始化向导。Linux 安装到 `~/.local/share/lingxi-remote/5.0.0`，Windows 安装到 `%LOCALAPPDATA%\LingXiRemote\5.0.0`；请保留这个目录。重复执行复用完整安装，并重新进入配置，不删除身份和配置。可通过环境变量 `LINGXI_REMOTE_HOME` 更换安装根目录，`LINGXI_REMOTE_VERSION` 指定已发布的版本（例如 `5.0.0`）。

如需手动下载，使用 [Release 页面](https://github.com/Cyber-bike1949/LingXi1949/releases)。Remote 5.0.0 直达链接：[Linux x64 平台包](https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-5.0.0/lingxi-remote-5.0.0-linux-x64.tar.gz) · [Windows x64 平台包](https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-5.0.0/lingxi-remote-5.0.0-win32-x64.tar.gz)。手动解压后，Windows 双击 `install.cmd`；Linux 执行 `bash install.sh`。

两台设备使用同一个安装入口，脚本自动补齐 Node.js 24 与生产依赖：

1. 在**被控制端**（存放项目、实际执行命令的设备）回车选择默认角色 `1`。脚本启动 Agent，显示连接码。
2. 在**控制端**（运行模型 CLI、发起任务的设备）选择 `2`，粘贴连接码。
3. 工作目录默认使用被控制端用户主目录，Shell 默认从被控制端实际存在的可执行程序中选择。界面显示路径和可用 Shell，回车使用默认值，也可填写项目目录或其他 Shell 的绝对路径。不会使用控制端本机路径猜测远程环境。
4. 选择 Codex、Claude 或两者；脚本安装缺失工具并添加 MCP 配置。账号登录仍需人工完成；选择 `none` 仅配置手动控制。

使用脚本输出的命令进入手动控制。日志和结果位于 `~/.lingxi-mcp`。一条复制命令完成下载、解压、环境安装和配置引导；跨设备仍需传递连接码，模型账号仍需本人登录。

脚本复用已有 Agent 和控制端身份，不重置配对。不自动配置开机自启。普通终端关闭后 Agent 继续运行；系统重启后重新运行脚本。已有运行 Agent 若低于本版本，应先停止并换用本版本后重跑。首次配置失败会显示具体步骤，模型登录未完成不会被称为已验证模型可用。

开发目录可用 `node scripts/setup.mjs --agent ABSOLUTE_AGENT_PATH ...`；支持 `--role controller|target --home PATH --ticket-file FILE --name NAME --workdir PATH --shell PATH --ai codex|claude|both|none`。`--loopback true` 仅用于本机隔离验证。

## 手动控制

```sh
node packages/lingxi-mcp/cli.mjs devices --probe true
node packages/lingxi-mcp/cli.mjs shell
node packages/lingxi-mcp/cli.mjs exec --session SESSION --command "pwd"
node packages/lingxi-mcp/cli.mjs list --session SESSION --path .
node packages/lingxi-mcp/cli.mjs upload --session SESSION --local ./example.bin --path example.bin
node packages/lingxi-mcp/cli.mjs download --session SESSION --path example.bin --local ./download.bin
```

`shell` 让用户选择设备，工作目录和 Shell 回车即可使用被控制端检测出的默认值，也可修改；输入普通文本执行命令，`/ls`、`/upload`、`/download`、`/exit` 完成文件操作或退出。每条命令独立执行，`cd` 不会改变下一条命令的固定工作目录。首期不是 vim 等全屏程序使用的交互式 PTY。

单文件上限 64 MiB，包含二进制和空文件；目录递归传输暂不提供。默认拒绝覆盖，显式 `--overwrite true` 才替换。同目录暂存完成后提交；断线清理失败会报告暂存文件名。硬链接提交要求目标与工作目录同一文件系统，否则失败并保持原文件。远程路径限于绑定目录，连接失败不在本机执行。每个会话一次只允许一个 CLI/MCP 进程，另开会话可避免锁冲突；Agent 同时只执行一条结构化命令。

MCP 旧的 UTF-8 读写接口仍限 128 KiB。`select --device DEVICE_ID` 可直接采用检测出的默认目录和 Shell；传入 `--workdir PATH --shell PATH` 可更换，生成新会话后重新接入模型。已有会话的绑定保持不变。

旧版 `init/pair/select/serve/tasks/config` 保留，详见 REMOTE_TASKS.md。协议探测返回实际在线状态，旧 Agent 不支持新接口时应升级。

## 构建和验证

Node.js 24+、pnpm 10.33.4、Rust 1.97.1：

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm build
pnpm test
pnpm test:installer
cargo test --locked --manifest-path agent/Cargo.toml
cargo build --locked --manifest-path agent/Cargo.toml
pnpm test:e2e
node scripts/setup.e2e.mjs
cargo build --release --locked --manifest-path agent/Cargo.toml
pnpm package
```

包在 `release-assets/`，含 Agent、SDK、MCP/手动入口、首次配置脚本及 SHA-256。CI 的测试包使用 debug Agent；正式发布流程构建 release Agent。共用库是版本化源码快照，不需要旁边存在插件仓库。macOS 等平台留有适配边界，尚未交付支持。

自动配置依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude MCP 文档](https://code.claude.com/docs/en/mcp)。安装版本固定为 Codex 0.166.0、Claude Code 2.1.316；已安装工具优先复用。配置成功不代表账号登录和真实模型调用已通过验收。
