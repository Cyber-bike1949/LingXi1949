# LingXi Remote 5.0

LingXi Remote 让你在一台电脑上，通过命令或 AI 工具操作另一台电脑的项目。不需要安装或运行 Obsidian。

**第一次使用，照着下面的“首次使用”操作即可。控制端和被控制端的配置都在这一页。** 手动配置、模型接入参数和工具说明见 [进阶文档](REMOTE_TASKS.md)。

## 首次使用

### 先分清两台设备

| 名称 | 用来做什么 | 安装时选择 |
| --- | --- | --- |
| 被控制端 | 存放项目，实际执行命令和修改文件 | `1`（默认） |
| 控制端 | 你日常操作的电脑，用来发送命令或运行 Codex / Claude | `2` |

例如：你用 Windows 笔记本操作 Linux 服务器上的项目，那么笔记本是**控制端**，服务器是**被控制端**。文件留在服务器上，不会自动同步到笔记本。

整个过程是：**被控制端安装 → 复制连接码 → 控制端安装 → 粘贴连接码 → 确认目录和 Shell → 开始使用**。

### 第一步：在被控制端安装

到**存放项目、准备被远程操作的设备**上，打开终端，按系统复制执行下面对应的整个代码块。

脚本会下载 [Remote 5.0.0](https://github.com/Cyber-bike1949/LingXi1949/releases/tag/remote-5.0.0)、校验文件、解压并启动配置向导，还会自动补齐 Node.js 和运行依赖。无需手动下载解压，也无需提前安装 Node.js、pnpm 或 Rust。首次安装需要联网，下载期间请等待。

目前支持 **Linux x64 和 Windows x64**，暂不支持 macOS 和 ARM 设备。

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

看到角色选择时：

1. 输入 `1`，或直接按回车，选择**被控制端**。
2. 等待出现“被控制端已就绪”。脚本已启动 Agent（负责接收远程任务的后台程序）。
3. 复制终端显示的**连接码**，稍后在控制端粘贴。

完成这一步后，让被控制端保持开机并联网。关闭安装终端不会停止 Agent。

### 第二步：在控制端连接

回到**你日常操作的电脑**，打开终端，执行上面对应系统的同一份安装命令，然后依次填写：

| 向导提示 | 怎么填 |
| --- | --- |
| 设备角色 | 输入 `2`，选择控制端 |
| 连接码 | 粘贴第一步从被控制端复制的连接码 |
| 设备名称 | 起一个方便辨认的名字，例如“家中服务器”；也可回车使用默认值 |
| 被控制端工作目录 | 回车使用默认目录，或填写被控制端上已有的项目完整路径 |
| 被控制端 Shell | 通常直接回车，使用自动检测到的默认值 |
| 配置 AI 工具 | 输入 `codex`、`claude`、`both` 或 `none`，含义见下一步 |

**工作目录是什么？** 就是远程命令开始执行的目录，也是远程文件工具操作的范围。默认是被控制端用户主目录；如果已有项目，建议填写项目目录，例如 Linux 的 `/home/alice/my-project` 或 Windows 的 `C:\Projects\my-project`。这里填写的是**被控制端的路径**。

**Shell 是什么？** 就是被控制端用来执行命令的程序。向导只会从那台设备实际存在的程序中检测默认值，并显示可用选项。不熟悉时直接回车即可；需要更换时，填写可用 Shell 的完整路径。

### 第三步：选择使用方式

| 输入 | 使用方式 |
| --- | --- |
| `codex` | 通过 Codex 操作被控制端 |
| `claude` | 通过 Claude Code 操作被控制端 |
| `both` | 两种工具都配置（默认） |
| `none` | 先不用 AI，只通过手动命令操作 |

选择 AI 工具后，脚本会安装缺失的工具并添加远程连接配置。**模型账号仍需你自己登录**，安装完成不等于账号已登录。

看到“设备连接与工具配置已完成”，表示设备连接和配置已完成。向导会输出手动控制入口；AI 工具的启动信息保存在控制端 `~/.lingxi-mcp/setup-result.json`。

使用 AI 时，可以先发送这样一条任务，确认连接的设备和目录正确：

> 请先调用 remote_target，告诉我当前连接的远程设备和工作目录；然后通过 lingxi 的 remote_list 列出该目录的文件。本次只查看，不修改文件，请使用远程工具执行。

更多模型接入说明见 [接入模型 CLI](REMOTE_TASKS.md#接入模型-cli)；手动操作见下方 [手动控制](#手动控制)。

## 安装后常见问题

### 以后还需要重新安装吗？

不需要。重复执行安装命令会复用完整安装，并重新进入配置向导，保留已有设备身份和配置。

脚本不会设置开机自启。被控制端重启后，重新执行安装命令并选择 `1`，即可再次启动。若正在运行旧版本 Agent，需要先停止旧版本，再启动新版本。

### 安装目录在哪里？

| 系统 | 默认安装目录 |
| --- | --- |
| Linux | `~/.local/share/lingxi-remote/5.0.0` |
| Windows | `%LOCALAPPDATA%\LingXiRemote\5.0.0` |

请保留安装目录。控制端的配置与任务记录默认放在 `~/.lingxi-mcp`；其中 `~` 表示当前用户的主目录。

### 安装失败怎么办？

先查看终端最后显示的错误，处理后再执行同一份安装命令：

- 下载失败：检查能否访问 GitHub，以及网络是否正常。
- 提示缺少系统工具：Linux 检查 `curl`、`tar`、`sha256sum`、`xz`；Windows 检查 `tar.exe`。
- 无法连接设备：确认被控制端已开机联网、Agent 已启动，连接码复制完整。
- 目录或 Shell 验证失败：确认填写的是被控制端上实际存在的完整路径，也可以重新运行向导使用默认值。
- AI 工具提示未登录：在相应工具中完成账号登录。

如果 Windows 安装时出现 `split(.)`、`Expected ')', got '.'`，这是 5.0.0 安装脚本的引号兼容问题。重新复制执行本文的 Windows 安装命令即可自动修复，已有安装、设备身份和配置会保留。请使用本文的在线安装命令；旧压缩包内的 `install.cmd` 本身不包含这项修复。

### 可以手动下载安装吗？

可以。在 [Remote 5.0.0 发布页](https://github.com/Cyber-bike1949/LingXi1949/releases/tag/remote-5.0.0) 下载对应平台包，或直接点击：

- [Linux x64 平台包](https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-5.0.0/lingxi-remote-5.0.0-linux-x64.tar.gz)：解压后，在解压目录执行 `bash install.sh`。
- [Windows x64 平台包](https://github.com/Cyber-bike1949/LingXi1949/releases/download/remote-5.0.0/lingxi-remote-5.0.0-win32-x64.tar.gz)：解压后，双击 `install.cmd`。

两种方式都会进入同一个配置向导。

### 需要自定义安装位置或使用高级参数？

安装前可通过环境变量 `LINGXI_REMOTE_HOME` 更换安装根目录，`LINGXI_REMOTE_VERSION` 指定已发布的版本（例如 `5.0.0`）。下载脚本名为 `install-remote.sh` / `install-remote.ps1`。

开发目录可用 `node scripts/setup.mjs --agent ABSOLUTE_AGENT_PATH ...`；支持 `--role controller|target --home PATH --ticket-file FILE --name NAME --workdir PATH --shell PATH --ai codex|claude|both|none`。`--loopback true` 仅用于本机隔离验证。

## 手动控制

以下命令适合熟悉命令行的用户，在安装目录执行。`node` 需要在当前终端可用；若由安装脚本自动下载，可使用向导输出的 Node 完整路径。`SESSION` 替换为配置生成的会话 ID。

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

旧版 `init/pair/select/serve/tasks/config` 保留，详见 [进阶文档](REMOTE_TASKS.md)。协议探测返回实际在线状态，旧 Agent 不支持新接口时应升级。

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
