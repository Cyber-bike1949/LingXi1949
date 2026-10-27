# 远程模型任务：A、B、C 三端首次使用指南

适用版本：LingXi1949 **4.0.0**。目标：在 A 的 Obsidian 中操作 B 上的 Codex 或 Claude，让模型读取、修改 C 的项目并在 C 执行命令。

第一次请按本文顺序操作，每一步确认成功后再继续。首次跑通后，日常只需执行第 7 节。

## 1. 先分清每台设备负责什么

| 设备 | 作用 | 必须准备 | 保存什么 |
| --- | --- | --- | --- |
| **A：操作端** | 显示 B 的终端、输入任务、查看记录 | Obsidian 桌面版、LingXi1949 插件 | 插件自己的设备列表 |
| **B：模型中心** | 运行模型、向 C 发出操作请求 | Node.js 24、lingxi-mcp、Codex 或 Claude Code；从 A 远程操作时还要运行 LingXi Agent | 模型登录信息、B 的配对列表、任务记录 |
| **C：执行端** | 实际读写文件、运行测试和构建 | **4.0.0 Agent**、项目文件、项目所需运行环境 | 项目代码和执行结果 |

C 不需要安装模型 CLI，也不需要 Node.js 来运行已编译的 Agent；项目本身需要 Node.js 时另算。A 不必安装模型 CLI。若直接坐在 B 前使用，可以跳过 A 和 B 上供 A 连接的 Agent。

```text
A：Obsidian ──远程终端──> B：Agent → Codex / Claude → lingxi-mcp
                                                       │
                                                   直接连接
                                                       ↓
                                                  C：Agent → 项目
```

有两份不同的连接码：**B 的码交给 A；C 的码交给 B**。A 以前连过 C，不代表 B 已经配对 C。

**连接限制：**每台 Agent 同时只接受一个控制端连接。B 连接 C 前，在 A 的设备列表中断开对 C 的连接；仅关闭一个终端标签不一定释放设备连接。A→B 可以保持连接。

### 下载还是源码安装？

先检查 [项目 Releases](https://github.com/Cyber-bike1949/LingXi1949/releases) 中是否有 **4.0.0 的对应附件**。Git tag 存在不等于安装包已发布；不要用 `latest` 下载的旧 Agent 代替 4.0.0。

- 有附件：A 使用对应平台插件包；B 使用 `lingxi-mcp-4.0.0.tar.gz`；B/C 使用各自平台的 Agent。
- 没有附件：使用下面的源码方式。本文整理时（2026-10-27），4.0.0 Release 查询返回 404，因此源码方式是可执行的备用路径。
- 旧版 `agent/packaging/install-linux.sh` 固定下载 2.1.0，**不要直接用它安装本功能所需的 C 端 Agent**。

下面以 **B、C 为 Linux，终端为 Bash/sh** 演示；Windows 差异见第 8 节。所有路径中的 `~` 都属于“当前执行命令的那台机器、当前登录用户”。

## 2. 在 C 准备项目和 Agent

**操作位置：C 的本机终端或已有 SSH 终端。**

### 2.1 准备项目目录

首次建议用一个空目录验证，成功后再选择真实项目：

```sh
mkdir -p ~/lingxi-demo
cd ~/lingxi-demo
pwd
command -v bash
```

记下这两项，后面在 B 输入：

- C 的工作目录绝对路径，例如 `/home/example/lingxi-demo`。
- C 的 Shell 绝对路径，例如 `/bin/bash` 或 `/usr/bin/bash`，以实际输出为准。

### 2.2 启动 4.0.0 Agent

**方式一：已取得 4.0.0 的 Linux x64 二进制。**在其所在目录执行（其他架构不能使用 x64 文件）：

```sh
chmod +x ./lingxi1949-linux-x64
./lingxi1949-linux-x64 run
```

**方式二：从源码构建。**先准备 Git 和 Rust；Rust 版本以仓库的 `rust-toolchain.toml` 为准。首次下载源码：

```sh
mkdir -p ~/tools
git clone --branch 4.0.0 https://github.com/Cyber-bike1949/LingXi1949.git ~/tools/LingXi1949
cd ~/tools/LingXi1949
cargo build --release --locked --manifest-path agent/Cargo.toml
./agent/target/release/lingxi1949 run
```

如果目录已经存在，使用已有的 4.0.0 checkout，不要再次 clone 到同一目录。源码构建 Agent 不需要安装 pnpm 或插件依赖。

**成功标志：**终端打印 `connection code`，下面有一整段以 `endpoint` 开头的连接码，并显示等待控制端连接。复制这一整段码，这是 **C 的连接码**，稍后交给 B。

保持这个终端运行。首次先以前台方式跑通；退出窗口会停止前台 Agent。若已有旧 Agent 服务，先停止旧进程再启动新版本，使用同一普通用户以沿用设备身份；遇到 `another lingxi1949 instance already holds ...` 表示旧进程仍在占用，不能同时再启动一份。不要为了升级执行 `rotate-identity`。

## 3. 在 B 安装模型工具，并让 A 能连接 B

**操作位置：B 的本机终端或已有 SSH 终端。**

### 3.1 准备模型 CLI 和 Node.js

安装 Node.js 24，以及 Codex、Claude Code 中至少一个。在 B 完成模型 CLI 自己的登录，先确认能正常启动并回答一个普通问题。这里的登录与 LingXi 配对是两件事。

```sh
node --version
npm --version
```

`node` 应显示 `v24.x`。再按所用工具检查 `codex --version` 或 `claude --version`；只有其中一个也可以继续。不要把在 A 上完成的登录当成 B 已登录。

### 3.2 安装 lingxi-mcp

**已有发行包：**把 MCP 包解压到 B 的固定目录，进入解压后含有 `package.json` 的目录，执行：

```sh
npm install --omit=dev
node packages/lingxi-mcp/cli.mjs --help
```

**使用源码：**准备 pnpm（版本见 `package.json` 的 `packageManager`），在 B 获取源码并构建 SDK：

```sh
mkdir -p ~/tools
git clone --branch 4.0.0 https://github.com/Cyber-bike1949/LingXi1949.git ~/tools/LingXi1949
cd ~/tools/LingXi1949
pnpm install --frozen-lockfile
pnpm build:mcp
node packages/lingxi-mcp/cli.mjs --help
```

**成功标志：**帮助中列出 `init`、`pair`、`devices`、`select`、`serve`、`tasks`、`config`。

下文的 `node packages/lingxi-mcp/cli.mjs ...` 都要在 **B 的 MCP 安装根目录**执行。配置成功后不要随意移动安装目录，因为模型配置会记录脚本绝对路径。

### 3.3 在 B 启动 Agent，供 A 使用

需要从 A 操作时，在 B **另开一个终端**，按第 2.2 节的方法安装/构建并启动 Agent。它与 B 上的 MCP 是两个程序：Agent 接受 A 的终端连接，MCP 负责连接 C。

复制 B 的 Agent 打印的连接码，交给 A。保持 B 的 Agent 运行，不要在这个前台 Agent 窗口中输入模型命令。

## 4. 在 A 打开 B 的终端

**操作位置：A 的 Obsidian。**

1. 安装并启用 LingXi1949 桌面插件。要使用“远程模型任务”窗口，插件需要 4.0.0。
2. 若没有 4.0.0 插件附件，在 A 准备 Node.js、pnpm、Rust 和 4.0.0 源码，在源码根目录执行 `pnpm install --frozen-lockfile`，再执行 `pnpm install:dev "你的 Vault 绝对路径"`。此命令会构建并安装到指定 Vault；已有插件用户应先保留当前安装的备份。更多说明见[开发指南](development_ZH.md)。
3. 在命令面板打开 LingXi1949 终端入口，选择“添加设备”，粘贴 **B 的连接码**，命名为“模型中心 B”。
4. 连接 B，为它新建一个终端。在这个终端运行 `hostname`、`pwd`，确认显示的是 B。
5. 如果 A 的设备列表中仍连接着 C，先断开 **C 的设备连接**，保留 B。

**成功标志：**能在 A 的窗口中操作 B 的 Shell。此后所有标注“在 B 执行”的命令，都可以在这个远程终端里输入。

当前插件中的“远程模型任务”窗口用于**查看记录**，不是选择 C 和工作目录的表单。选择步骤在下一节的 B 终端完成。

## 5. 在 B 初始化、配对 C、固定本轮目标

**操作位置：B 的终端；当前目录为 B 的 MCP 安装根目录。**

### 5.1 初始化一次

```sh
node packages/lingxi-mcp/cli.mjs init
```

成功返回 `initialized: true` 和 `home`。记下 `home`，这是 **B 的 MCP 数据目录**，默认是 B 当前用户的 `~/.lingxi-mcp`。

若返回 `PROFILE_ALREADY_EXISTS`，说明这个用户已初始化，继续即可；不需要删除数据重来。后续操作始终使用同一个 B 用户。若自定义了 `--home`，后续每条 MCP 命令都要带同一值。

### 5.2 把 C 的连接码保存到 B，再配对

用 B 的文本编辑器创建 `c-ticket.txt`，只粘贴 C 的完整连接码，不带引号、标题或 Markdown 围栏。例如文件就放在 B 的 MCP 安装根目录，然后执行：

```sh
node packages/lingxi-mcp/cli.mjs pair --name C --ticket-file ./c-ticket.txt
node packages/lingxi-mcp/cli.mjs devices --probe true
```

**成功标志：**配对返回 `deviceId`，探测列表中 C 的 `status` 为 `online`。保存完整 `deviceId`；后面不能用显示名称 `C` 代替它。

连接码文件在 B；它指向 C。它不需要写进 C 的项目，也不用复制 A 的插件配置。连接码按现有 LingXi 规则授予访问能力，请勿提交到项目仓库。

### 5.3 选择 C 的工作目录和 Shell

将下列三个示例值替换成前面取得的实际值：

```sh
node packages/lingxi-mcp/cli.mjs select --device "C的完整deviceId" --workdir "/home/example/lingxi-demo" --shell "/bin/bash"
```

`--workdir` 和 `--shell` 都属于 **C**，不是 B。目录必须已经存在；使用绝对路径，不要在这里填写 B 展开后的 `~` 路径。

成功输出会同时包含：

```json
{
  "session": "持久选择标识，后续配置使用这个值",
  "sessionId": "本次远程连接的临时会话标识",
  "bindingVersion": "本次绑定版本",
  "deviceId": "C的设备身份",
  "workDir": "/home/example/lingxi-demo",
  "shell": "/bin/bash"
}
```

**一定保存 `session`，不要保存错成 `sessionId`。**后文的 `SESSION_ID` 占位符一律替换为 `session` 的实际值。`select` 是预检和保存选择，结束后会断开此次临时连接；模型 CLI 启动 MCP 时会重新建立远程会话。

## 6. 在 B 接入模型，并完成第一个任务

### 6.1 生成正确的启动配置

仍在 B 的 MCP 安装根目录执行：

```sh
node packages/lingxi-mcp/cli.mjs config --session "SESSION_ID"
```

这条命令**只打印配置，不会自动修改 Codex 或 Claude 的配置文件**。输出中的 `command` 是 B 的 Node 绝对路径，`args` 包含 B 的脚本路径、数据目录与刚选定的 `session`。

不要另外手动运行 `serve` 再去启动模型。`serve` 会等待 MCP 输入，正常情况下由模型 CLI 自动启动；手动运行一份可能占用同一个选择或 C 的连接。

### 6.2 选择一种 CLI 配置方式

**Codex：**编辑 **B 的** `~/.codex/config.toml`，增加或更新下面一段。用上一步 `codex.mcp_servers.lingxi` 中的实际值填写 `command` 和完整 `args`，保留已有的其他配置：

```toml
[mcp_servers.lingxi]
command = "/B上的Node绝对路径"
args = ["/B上的MCP安装目录/packages/lingxi-mcp/cli.mjs", "serve", "--home", "/B上的MCP数据目录", "--session", "SESSION_ID"]
startup_timeout_sec = 180
tool_timeout_sec = 3660
```

不要把 `config` 输出的整份 JSON 直接粘进 TOML。若已有 `[mcp_servers.lingxi]`，修改它，不能重复添加同名表。

**Claude Code：**在 B 选择一个用于启动 Claude 的本地目录，在其 `.mcp.json` 中合并上一步输出的 **`mcpServers` 对象**。文件形状如下，实际字符串直接复制生成结果：

```json
{
  "mcpServers": {
    "lingxi": {
      "command": "/B上的Node绝对路径",
      "args": ["/B上的MCP安装目录/packages/lingxi-mcp/cli.mjs", "serve", "--home", "/B上的MCP数据目录", "--session", "SESSION_ID"]
    }
  }
}
```

之后从这个目录启动 `claude`，按 CLI 提示批准项目 MCP 配置。若已有 `.mcp.json`，只合并 `lingxi` 条目，不覆盖其他服务。也可采用根目录[工具说明](../REMOTE_TASKS.md#接入模型-cli)中的 `claude mcp add` 注册方式。

首次请选择 Codex 或 Claude **其中一个**测试，不要让两者同时使用同一个选择连接 C。B 的模型启动目录可以与 MCP 安装目录不同，也不需要拥有 C 的项目副本。

### 6.3 确认模型已经连接

在 B 启动 `codex` 或 `claude`，输入 `/mcp` 查看 `lingxi` 状态。修改配置后重新启动对应 CLI。

然后发送：

> 请先调用 lingxi 的 remote_target，告诉我当前 deviceId、workDir、shell 和 connected。暂时不要修改文件，也不要运行本地命令。

**成功标志：**模型实际调用工具，返回 C 的设备身份、刚选定的目录和 Shell，且 `connected` 为 `true`。只看模型自然语言说“已连接”不够，要核对工具返回值。

### 6.4 做一次可检查的读写与执行

确认 C 的测试目录中没有下面这个同名文件，再发送：

> 本轮只使用 lingxi 的 remote_* 工具，禁止用 B 的本地文件或 Shell 工具代替。请在绑定目录创建 `.lingxi-first-run.txt`，内容为 `hello from remote task`；再读取并核对内容；最后通过 remote_exec 执行 `pwd` 和 `hostname`。每次操作使用不同的 requestId，汇报 taskId、文件内容、实际目录、主机名和退出码。

到 C 的终端验证：

```sh
cd ~/lingxi-demo
cat .lingxi-first-run.txt
```

应能看到指定内容，命令结果中的目录和主机名应属于 C。实际项目任务也需要明确让模型使用 `remote_*`：MCP 不会把 CLI 自带的本地工具自动改成远程执行。

### 6.5 查看记录

**B 端：**另开 B 终端，进入 MCP 安装根目录后执行：

```sh
node packages/lingxi-mcp/cli.mjs tasks --session "SESSION_ID"
```

**A 端：**Obsidian 命令面板 →“远程模型任务”→ 选择 **B** → 填写 `init` 返回的 B 数据目录加上 `/tasks.json` →“刷新任务”。例如 `/home/example/.lingxi-mcp/tasks.json`。不要选 C，也不要填写 A 的本地路径。

`tasks.json` 在 MCP 服务启动并记录状态后生成。窗口展示最近保存的快照和时间；它不是实时进程监控。完整记录保存在 B 的 `tasks.sqlite`。

## 7. 以后每次怎样启动、切换和结束

| 场景 | 操作顺序 |
| --- | --- |
| 继续使用同一台 C、同一目录 | 启动 C Agent → 启动 B Agent（需要 A 时）→ A 连接 B → 在 B 启动已配置的模型 CLI。通常不用再 `init`、`pair`、`select`。 |
| 换 C 的项目目录或 Shell | 先退出旧模型会话，释放连接 → 在 B 再执行 `select` → 用新的 `session` 生成并更新 MCP 配置 → 重启模型。 |
| 换成另一台 D | 在 D 启动 Agent → 在 B 用 D 的连接码 `pair` → `select` D → 更新配置。不能只修改模型提示中的设备名称。 |
| 同时操作 C、D | 为两台目标分别建立选择，在独立模型配置/会话中使用。不要在仍运行的会话下覆盖选择。 |
| 取消正在运行的命令 | 在支持并行工具操作的客户端调用 `remote_cancel(taskId)`，或使用模型 CLI 的取消功能；以远端返回 `CANCELLED` 为确认。必要时结束该 MCP 会话。 |
| 网络中断 | 查看已有输出和 `UNKNOWN` 状态，先核对 C 的实际文件/进程，再恢复连接；不会自动重放写入或命令。确认需要重试时使用新的 requestId。 |
| 结束使用 | 先退出 B 的模型 CLI，释放 MCP→C 连接。Agent 可以继续运行，方便下次连接；停止前台 Agent 使用其终端的 Ctrl+C。 |

## 8. Windows 上哪里不同

- **A 为 Windows：**按第 4 节使用 Obsidian，B 的远程终端里仍输入 B 所用 Shell 的命令。
- **B/C 为 Windows：**使用 4.0.0 的 `lingxi1949-win32-x64.exe`，在 PowerShell 中执行 `./lingxi1949-win32-x64.exe run`。源码构建后文件位于 `agent/target/release/lingxi1949.exe`。
- **B 为 Windows：**安装 Windows Node.js 24，在 MCP 根目录运行相同的 `node packages/lingxi-mcp/cli.mjs ...` 命令；`init` 会返回实际数据目录。连接码文件保存为不带 BOM 的 UTF-8 文本，避免把标题一起保存。
- **C 为 Windows：**在 C 上用 `Get-Location` 获取工作目录，用 `(Get-Command powershell.exe).Source` 获取 Shell 路径。在 B 的 `select` 参数中使用 C 的这些值，例如 `--workdir 'C:\work\demo' --shell 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'`。
- **配置文件：**直接使用 `config` 生成的 JSON 字符串处理 Windows 路径转义。Codex 的 `command` 与 `args` 可按生成值填入 TOML；不要手工把 JSON 中的双反斜杠变成未转义的单反斜杠。
- **第一次测试：**C 为 PowerShell 时，将远程测试命令的 `pwd` 改成 `Get-Location`；本机读取验证使用 `Get-Content .lingxi-first-run.txt`。

当前自动化验收主要覆盖 Linux loopback 环境。Windows 进程清理、桌面交互和跨公网环境仍需实际验证，见[验收记录](../IMPLEMENTATION_4.0.md)。

## 9. 卡在哪一步，就查对应问题

| 现象 | 检查与处理 |
| --- | --- |
| `PROFILE_ALREADY_EXISTS` | 已初始化。继续配对/选择，不删除已有 profile。 |
| `Cannot find module ...remote-sdk/dist...` | 源码安装缺少 `pnpm build:mcp`，或安装目录不完整。 |
| SQLite 模块无法加载 | B 正在用旧 Node；检查 `node --version`，模型配置中也必须使用 Node 24 的绝对路径。 |
| `TICKET_INVALID` | B 的文本文件必须是 C 的完整连接码；检查复制是否截断、是否有标题/引号。 |
| `devices` 显示 `not-probed` | 只读取了本地配对列表；尚未运行 `devices --probe true`。 |
| `CONTROLLER_ALREADY_CONNECTED` / `unavailable` | A 可能仍连着 C，或另一份 MCP 占用 C。断开设备连接/退出占用会话；已在工作的 MCP 也会使另一次独立探测无法接管连接。 |
| `CONNECT_TIMEOUT` | 检查目标 Agent 是否运行、身份是否变更、网络是否可达；正常跨设备使用不要加 `--loopback true`。 |
| `SESSION_ALREADY_RUNNING` | 同一个 `session` 已被使用，常见于手动启动了 `serve` 又启动模型。退出占用进程，不要直接删除活跃锁文件。 |
| `session-...json` 不存在 | 把 `sessionId` 错当 `session`，或换了 B 用户/`--home`。回看 `select` 的顶层 `session`。 |
| `DEVICE_NOT_PAIRED` | 在 B 配对的是哪个数据目录？`--device` 必须是完整 deviceId，不能填 `C`。 |
| `NOT_A_DIRECTORY` / `SHELL_REQUIRES_EXISTING_ABSOLUTE_PATH` | `select` 用的是 C 的实际目录和 Shell 绝对路径吗？先去 C 验证。 |
| 旧 Agent 报协议/未知帧错误 | C 必须升级到 4.0.0；旧终端能连通不代表支持远程任务协议。 |
| `/mcp` 没有 lingxi | 配置是否写在 B？Claude 是否从含 `.mcp.json` 的目录启动？是否已重启并批准项目配置？ |
| 模型改了 B 的文件 | 它使用了 CLI 自带的本地工具。先核对 `remote_target`，重新明确只使用 `remote_*`。 |
| A 无法读取任务记录 | 选择 B，填写 B 的绝对路径，确认 B 的 Agent 运行、MCP 曾经启动，且文件对 B 的 Agent 用户可读。 |
| 任务 `UNKNOWN` | 结果未确认，不代表“未执行”。先查目标实际状态，再决定是否用新 requestId 重试。 |

单文件 UTF-8 内容上限 128 KiB，单命令输出上限 1 MiB，默认命令超时 120 秒；更多工具参数与限制见[远程任务工具说明](../REMOTE_TASKS.md)。

## 10. 完成首次配置的检查表

- [ ] C 的 4.0.0 Agent 持续运行，项目目录和 Shell 已确认。
- [ ] B 的 Node.js 为 24，模型 CLI 已在 B 登录。
- [ ] 使用 A 时，B 的 Agent 运行，A 的终端确认连接到 B。
- [ ] B 已用 C 的码配对，A 已断开对 C 的直接连接。
- [ ] 保存了 `select` 的 `session`，没有误用 `sessionId`。
- [ ] MCP 配置写在 B，使用 B 的 Node/脚本路径和 C 的已选绑定。
- [ ] 模型实际调用 `remote_target` 并返回 C 的身份。
- [ ] C 出现测试文件，读回内容正确，命令返回 C 的目录和主机名。
- [ ] B 能查询任务记录；需要时 A 能刷新 B 的任务快照。

CLI 配置参考：[Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)、[Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。本文的 LingXi 命令、输出字段与入口按本仓库 4.0.0 实现核对。
