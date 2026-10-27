# 远程模型任务首次使用指南（A / B / C）

本文只讲第一次跑通一条完整链路：

```text
A：Obsidian  ──连接──>  B：模型 CLI + MCP  ──连接──>  C：Agent + 项目
```

请严格按顺序执行。每一步的“完成标志”出现后再继续。

适用版本：**4.0.0**。B、C 不要求必须是 Linux，当前提供 Linux x64 和 Windows x64 一键安装包。

## 第 1 步：确认三台设备的职责

| 设备 | 做什么 | 是否必须 |
| --- | --- | --- |
| A 操作端 | 运行 Obsidian，查看 B 的终端和任务记录 | 使用 Obsidian 时必须；可以不参与首次配对 |
| B 模型端 | 运行 Codex/Claude、MCP，并连接 C | 必须 |
| C 执行端 | 运行项目命令、读写项目文件 | 必须 |

连接码也有两份：**B 的连接码交给 A，C 的连接码交给 B**。不要混用。

如果只想在 B 本机运行模型并控制 C，可以跳过 A；如果还要从 Obsidian 操作 B，就继续完成第 5 步。

## 第 2 步：安装 C（执行端）

以下命令必须在 **C** 执行。使用实际运行 Agent 的普通用户，不要使用 `sudo`。安装器不会启动服务，也不会删除已有身份。

### Linux x64

```sh
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/scripts/install.sh -o lingxi-install.sh
bash ./lingxi-install.sh --role c
```

### Windows x64（PowerShell）

```powershell
$ErrorActionPreference = 'Stop'
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/scripts/install.ps1 -OutFile .\lingxi-install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\lingxi-install.ps1 -Role c
```

完成标志：看到 `Installed LingXi 4.0.0, role c.`。安装器会下载 Release 附件并校验 SHA-256。

### 在 C 启动 Agent

先准备一个测试目录，并记下**绝对路径**和 Shell 路径。

Linux：

```sh
mkdir -p ~/lingxi-demo
cd ~/lingxi-demo
pwd
command -v bash
```

Windows：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\lingxi-demo"
Set-Location "$env:USERPROFILE\lingxi-demo"
Get-Location
(Get-Command powershell.exe).Source
```

保持 Agent 前台运行。Linux：

```sh
~/.local/share/lingxi1949-install/bin/lingxi1949 run
```

Windows：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\LingXi1949-install\bin\lingxi1949.ps1" run
```

完成标志：终端打印一整段包含 `endpoint` 的连接码，并显示等待连接。把它暂存好，它是 **C 的连接码**，下一步交给 B。

## 第 3 步：安装 B（模型端）

以下命令必须在 **B** 执行。B 需要 Node.js 24+ 和 npm，还需要至少安装并登录 Codex 或 Claude Code。安装器不会替换 Node，也不会替你登录模型。

### Linux x64

```sh
node --version   # 应为 v24.x
npm --version
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/scripts/install.sh -o lingxi-install.sh
bash ./lingxi-install.sh --role b
```

### Windows x64（PowerShell）

```powershell
$ErrorActionPreference = 'Stop'
node --version       # 应为 v24.x
npm --version
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/scripts/install.ps1 -OutFile .\lingxi-install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\lingxi-install.ps1 -Role b
```

完成标志：看到 `Installed LingXi 4.0.0, role b.`。B 安装后有两个入口：

| 系统 | Agent | MCP |
| --- | --- | --- |
| Linux | `~/.local/share/lingxi1949-install/bin/lingxi1949` | `~/.local/share/lingxi1949-install/bin/lingxi-mcp` |
| Windows | `%LOCALAPPDATA%\LingXi1949-install\bin\lingxi1949.ps1` | `%LOCALAPPDATA%\LingXi1949-install\bin\lingxi-mcp.ps1` |

## 第 4 步：启动 B 的 Agent（需要从 A 操作 B 时才执行）

另开一个 B 终端启动 Agent，不要在这个窗口里运行模型 CLI。

Linux：

```sh
~/.local/share/lingxi1949-install/bin/lingxi1949 run
```

Windows：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\LingXi1949-install\bin\lingxi1949.ps1" run
```

把 B Agent 打印的连接码暂存好，它是 **B 的连接码**，下一步交给 A。

## 第 5 步：在 A 连接 B（可选）

1. 在 A 的 Obsidian 安装并启用 LingXi1949 4.0.0。
2. 打开命令面板，选择 LingXi1949 的“添加设备”。
3. 粘贴 **B 的连接码**，命名为“模型中心 B”。
4. 连接 B，打开终端，执行 `hostname` 和 `pwd`（Windows 执行 `hostname` 和 `Get-Location`）。

完成标志：A 的终端显示的是 B 的主机和目录。之后文档写“在 B 执行”时，可以直接在这个终端执行。如果不使用 A，本节跳过，后续命令直接在 B 本机执行。

## 第 6 步：在 B 初始化 MCP，并配对 C

以下命令在 **B** 执行。Linux 先设置：

```sh
MCP="$HOME/.local/share/lingxi1949-install/bin/lingxi-mcp"
```

Windows 先设置：

```powershell
$Mcp = "$env:LOCALAPPDATA\LingXi1949-install\bin\lingxi-mcp.ps1"
```

### 6.1 初始化一次

Linux：`"$MCP" init`

Windows：`& $Mcp init`

成功会返回 `initialized: true` 和 `home`。记下 `home`，后续始终使用同一个 B 用户和同一个 MCP 数据目录。若返回 `PROFILE_ALREADY_EXISTS`，不要删除 profile，直接继续。

### 6.2 保存 C 的连接码并配对

在 B 创建 `c-ticket.txt`，只粘贴 C 的完整连接码，不要加入标题、引号或 Markdown 围栏。

Linux：

```sh
"$MCP" pair --name C --ticket-file ./c-ticket.txt
"$MCP" devices --probe true
```

Windows：

```powershell
& $Mcp pair --name C --ticket-file .\c-ticket.txt
& $Mcp devices --probe true
```

完成标志：`pair` 返回 `deviceId`，`devices --probe true` 中 C 的状态为 `online`。记下完整 `deviceId`，后面不能用名称 `C` 代替它。

### 6.3 固定 C 的项目目录和 Shell

使用第 2 步记下的 C 路径。Linux 示例：

```sh
"$MCP" select --device "C的完整deviceId" --workdir "/home/example/lingxi-demo" --shell "/bin/bash"
```

Windows 示例：

```powershell
& $Mcp select --device "C的完整deviceId" --workdir 'C:\Users\example\lingxi-demo' --shell 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
```

`--workdir` 和 `--shell` 属于 C，不属于 B；必须使用绝对路径。输出中有两个容易混淆的字段：保存 `session`，不要把临时的 `sessionId` 用于后续配置。

## 第 7 步：把 MCP 接入 Codex 或 Claude

### 7.1 生成配置

把第 6.3 步输出的 `session` 替换为 `SESSION`。

Linux：`"$MCP" config --session "SESSION"`

Windows：`& $Mcp config --session 'SESSION'`

这条命令只打印配置，不会自动修改模型 CLI 配置。输出包含 B 的 Node 绝对路径、MCP 脚本路径、数据目录和 session。

### 7.2 配置一个模型 CLI

第一次只选择 Codex 或 Claude 其中一个测试。

- Codex：把输出中的 `codex.mcp_servers.lingxi` 合并到 **B 的** `~/.codex/config.toml`。已有同名表时修改它，不要重复添加。
- Claude Code：把输出中的 `mcpServers.lingxi` 合并到 **B 的** `.mcp.json`。已有其他服务时只增加 `lingxi`，不要覆盖整个文件。

修改后重启模型 CLI，在模型 CLI 中执行 `/mcp`，确认 `lingxi` 已连接。

## 第 8 步：完成第一次安全测试

先发送：

> 只调用 lingxi 的 remote_target，告诉我当前 deviceId、workDir、shell 和 connected。不要修改文件，不要运行命令。

确认返回的是 C 的 `deviceId`、第 6.3 步的 `workDir`，且 `connected` 为 `true`。然后发送：

> 只使用 lingxi 的 remote_* 工具。在绑定目录创建 `.lingxi-first-run.txt`，内容为 `hello from remote task`；读取并核对内容；最后通过 remote_exec 执行 `pwd` 和 `hostname`。汇报 taskId、文件内容、实际目录、主机名和退出码。

到 C 检查文件：

Linux：`cat ~/lingxi-demo/.lingxi-first-run.txt`

Windows：`Get-Content "$env:USERPROFILE\lingxi-demo\.lingxi-first-run.txt"`

完成标志：文件在 C 出现，目录和主机名也属于 C。模型不会自动把本地工具变成远程工具，必须明确要求使用 `remote_*`。

## 第 9 步：查看任务记录

任务记录保存在 B。MCP 启动并产生任务后执行：

Linux：`"$MCP" tasks --session "SESSION"`

Windows：`& $Mcp tasks --session 'SESSION'`

A 的 Obsidian 命令面板 →“远程模型任务”→ 选择 **B** → 填写 B 的 MCP `home` 目录下的任务快照路径。不要选择 C，也不要填写 A 的本地路径。

## 第 10 步：以后每次使用

1. 启动 C Agent。
2. 如果要从 A 操作 B，启动 B Agent，并在 A 连接 B。
3. 在 B 启动已经配置好的 Codex 或 Claude。
4. 不要重复 `init`、`pair`、`select`；只有切换设备、目录或 Shell 时才重新 `select` 并更新 MCP 配置。
5. 结束时退出模型 CLI；Agent 可以继续运行。不要同时启动两份同一用户的 Agent。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `PROFILE_ALREADY_EXISTS` | 已初始化，继续使用原 profile，不要删除。 |
| `TICKET_INVALID` | 重新复制 C 的完整连接码，去掉标题、引号和多余内容。 |
| `devices` 是 `not-probed` | 加上 `--probe true`；这是未探测，不是配对失败。 |
| `CONNECT_TIMEOUT` | 确认目标 Agent 正在运行、网络可达，并使用同一设备身份；跨设备不要使用 `--loopback true`。 |
| `CONTROLLER_ALREADY_CONNECTED` | A 还连接着 C，或已有 MCP 会话占用 C。断开 A→C，退出占用会话。 |
| `SESSION_ALREADY_RUNNING` | 同一 session 已被另一份 MCP 使用；退出旧模型，不要删除活跃锁文件。 |
| `DEVICE_NOT_PAIRED` | `--device` 必须是完整 `deviceId`，且命令使用了正确的 B MCP 数据目录。 |
| `/mcp` 没有 `lingxi` | 检查配置是否写在 B，重启 Codex/Claude；Claude 还要从含 `.mcp.json` 的目录启动。 |
| 模型修改了 B 的文件 | 模型使用了本地工具；重新要求只使用 `remote_*`，先核对 `remote_target`。 |
| 旧 Agent 报未知帧或协议错误 | B、C 都升级到 4.0.0；旧 Agent 能连通不代表支持远程任务协议。 |

更多工具参数和限制见[远程任务工具说明](../REMOTE_TASKS.md)。安装器和平台范围见 [4.0.0 Release](https://github.com/Cyber-bike1949/LingXi1949/releases/tag/4.0.0)。
