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

看到“设备连接与工具配置已完成”，表示设备连接和配置已完成。手动操作请使用安装目录中的 `control.cmd`（Windows）或 `control.sh`（Linux）；AI 工具的启动信息保存在控制端 `~/.lingxi-mcp/setup-result.json`。

使用 AI 时，可以先发送这样一条任务，确认连接的设备和目录正确：

> 请先调用 remote_target，告诉我当前连接的远程设备和工作目录；然后通过 lingxi 的 remote_list 列出该目录的文件。本次只查看，不修改文件，请使用远程工具执行。

更多模型接入说明见 [接入模型 CLI](REMOTE_TASKS.md#接入模型-cli)；手动操作见下方 [手动控制](#手动控制)。

### 修改工作目录或 AI 操作的设备

“设备、工作目录、Shell”会在创建手动终端或 AI 会话时一起固定；AI 不能在提示词、工具参数或路径中改写它们。

- **手动终端：** 每次启动 `control.sh` / `control.cmd` 并选择设备后，按“被控制端工作目录”提示输入新的 Windows 绝对路径，例如 `C:\Projects\my-app`。进入终端后可直接执行 `cd 'C:\Projects\other-app'`；这个 `cd` 仅对当前 PTY 有效。要让 `/ls`、上传和下载也以新目录为根，退出后新建终端，并在创建时填写新目录。
- **AI CLI：** Linux 控制端执行 `bash ~/.local/share/lingxi-remote/5.0.0/control.sh ai`；Windows 控制端在终端执行 `control.cmd ai`。然后只需依次选择设备、远端工作目录、Shell 和 `codex` 或 `claude`。入口会自动创建固定绑定、替换 LingXi MCP 配置并启动所选 AI CLI；不需要输入设备 ID、session 或编辑配置文件。想换设备或 AI 工作目录时，先退出 AI CLI，再重新执行同一条 `control ... ai` 命令并重新选择。

断线后旧终端和旧 AI 请求不接管、不改派；重新启动控制入口后，选择同一已配对设备即可重新建立一个新会话，无须再次输入连接码。只有身份或配对授权轮换、或控制端配对资料丢失时，才需要重新配对。

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

完成控制端配置后，日常使用不用重新安装，也不用填写会话 ID 或 Node.js 路径。

### 1. 打开手动控制

**Windows**：打开安装目录，双击 **`control.cmd`**。默认目录可直接粘贴到文件资源管理器地址栏：

```text
%LOCALAPPDATA%\LingXiRemote\5.0.0
```

**Linux**：在终端执行：

```bash
bash ~/.local/share/lingxi-remote/5.0.0/control.sh
```

如果安装时自定义了目录，就打开那个目录下的 `control.cmd` 或 `control.sh`。入口会自动使用安装时准备好的 Node.js。

**已经安装了 5.0.0，但找不到 `control` 文件？** 重新执行上方的一键安装命令即可补齐入口并修复运行依赖，已有身份和配置会保留。旧压缩包需要通过在线安装命令更新。

### 2. 选择被控制端

1. 输入列表中要操作的设备编号。
2. 工作目录直接回车使用默认值；要操作某个项目，就填写被控制端上的项目完整路径。
3. Shell 通常直接回车即可。

连接后进入的是目标设备上的持续交互终端：`cd`、环境变量、前台程序、方向键、Ctrl+C 和窗口尺寸均属于该终端，不会被控制端按“每行命令”重写。想换一台设备，按 `Ctrl+]`，输入 `/exit` 退出，再打开手动控制并重新选择。

### 3. 输入命令或传文件

| 想做什么 | 输入什么 |
| --- | --- |
| 打开控制命令入口 | `Ctrl+]` |
| 查看当前绑定目录的文件 | 在控制入口输入 `/ls` |
| 查看某个子目录 | 在控制入口输入 `/ls src` |
| 上传文件到被控制端 | 在控制入口输入 `/upload`，然后按提示填写文件路径 |
| 下载文件到控制端 | 在控制入口输入 `/download`，然后按提示填写文件路径 |
| 执行命令 | 直接在终端输入，例如 `git status` |
| 退出手动控制 | 在控制入口输入 `/exit` |

上传、下载时，“本地”指控制端，“远程”指被控制端。单个文件最大 64 MiB，暂不支持整个文件夹；遇到同名文件默认不会覆盖。

终端以选择时确认的远端目录启动；在其中执行的 `cd` 会持续生效。`/ls`、`/upload`、`/download` 仍使用会话创建时的绑定目录，不会根据显示名称、IP 或本机目录推断目标。控制入口使用 `Ctrl+]` 是为了防止 `vim` 等程序标准输入中的 `/upload` 被误当作控制命令。

需要编写自动化脚本、指定会话或查询传输限制时，再看 [手动控制命令参考](REMOTE_TASKS.md#手动控制命令参考)。

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
