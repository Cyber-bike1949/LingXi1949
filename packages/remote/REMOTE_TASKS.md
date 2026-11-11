# 远程模型任务：进阶配置与工具参考（5.0）

## 这份文档适合谁？

**第一次安装或配置控制端、被控制端，请看 [README：首次使用](README.md#首次使用)。** 那里按操作顺序说明了安装命令、连接码、工作目录和 Shell 的选择。

本文用于需要手动初始化、手动配置模型接入、查询工具参数或排查任务记录的用户。已经用安装向导配置成功的，无需重复执行下面的初始化命令。

- **被控制端**：存放项目，实际执行命令和修改文件。
- **控制端**：运行 Codex / Claude 或手动命令，向被控制端发送任务。
- **Obsidian（可选）**：可以打开终端或查看任务记录，不是必需的第三台设备。

控制端直接连接被控制端，文件不会自动同步。下方命令中的 `DEVICE_ID`、`SESSION_ID` 和示例路径都需要替换为自己的实际值。

## 手动初始化（高级用法）

以下命令在完整平台包目录的控制端执行，Node.js 24 可由安装入口自动准备：

```sh
node packages/lingxi-mcp/cli.mjs init
node packages/lingxi-mcp/cli.mjs pair --name 开发设备 --ticket-file /path/to/ticket.txt
node packages/lingxi-mcp/cli.mjs devices --probe true
node packages/lingxi-mcp/cli.mjs select --device DEVICE_ID
```

`select` 自动探测被控制端默认目录和 Shell，也可通过 `--workdir PATH --shell PATH` 分别覆盖。它连接并验证路径，返回新 `session`。修改目录或 Shell 时再次运行 `select` 并接入新会话；已有会话保持原绑定。旧 Agent 若不提供默认值，请升级或显式传入两个路径。

默认数据目录为控制端的 `~/.lingxi-mcp`；所有命令支持 `--home /absolute/path`。安装脚本保留已有身份与配置。`profile.json` 保存控制端身份与配对设备，不读取 Obsidian 身份。连接码沿用既有 LingXi 信任语义。

Agent 同时只允许一个控制连接。控制端连接前，请关闭 Obsidian 到同一被控制端的连接。不同模型会话可以绑定不同被控制端并发；同一被控制端同时只运行一个命令，冲突返回 `DEVICE_BUSY`。同一个会话不可被两个 MCP 进程同时打开。

## 接入模型 CLI

先生成包含实际 Node 与脚本绝对路径的配置资料：

```sh
node packages/lingxi-mcp/cli.mjs config --session SESSION_ID
```

Codex 的配置放在 控制端的 `~/.codex/config.toml`，例：

```toml
[mcp_servers.lingxi]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/lingxi-remote/packages/lingxi-mcp/cli.mjs", "serve", "--session", "SESSION_ID"]
startup_timeout_sec = 180
tool_timeout_sec = 3660
```

也可用 `codex mcp add lingxi -- /absolute/path/to/node /absolute/path/to/lingxi-remote/packages/lingxi-mcp/cli.mjs serve --session SESSION_ID` 注册，再调整上述超时。使用 `/mcp` 检查连接。配置格式和超时字段依据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

Claude Code 在控制端注册：

```sh
claude mcp add --transport stdio lingxi -- /absolute/path/to/node /absolute/path/to/lingxi-remote/packages/lingxi-mcp/cli.mjs serve --session SESSION_ID
```

也可将 `config` 输出中的 `mcpServers` 对象写入项目 `.mcp.json`。通过 `/mcp` 查看连接；注册参数依据 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。两种 CLI 的真实模型登录与完整任务测试仍需在用户环境完成，当前验收覆盖标准 MCP 协议客户端。

给模型的任务建议明确写出：“先调用 remote_target 确认目标。本轮所有文件和命令仅通过 lingxi 的 remote_* 工具执行，不能用本地工具代替。读取文件、完成修改并运行测试，最后报告 taskId 和退出码。”MCP 只能约束自己的远程工具，无法禁用模型 CLI 自带的本地 Shell/文件工具。

### 切换 AI 远程设备或工作目录

日常使用不需要理解 `DEVICE_ID` 或 session。Linux 控制端先运行 `bash ~/.local/share/lingxi-remote/5.0.6/control.sh ai`；Windows 控制端在安装目录终端运行 `control.cmd ai`。按提示选择设备、远端目录和 Shell 后，入口创建不可变的当前 AI 绑定。随后运行 `control.sh codex` 或 `control.sh claude`（Windows 为 `control.cmd codex` / `control.cmd claude`）启动 AI。要切换设备或目录，先重新运行 `ai`；已启动的 AI 会话不能被悄悄迁移。严格模式不得通过修改用户全局 MCP 配置实现，也不得在隔离运行时缺失时降级为可访问控制端的本机 AI。

Linux 严格模式需要 `bubblewrap`（Ubuntu：`sudo apt install bubblewrap`）。启动器在宿主侧为当前 session 创建真实 MCP 服务，配对密钥和 session 文件不进入沙箱；沙箱中的 AI CLI 只能通过 Unix socket 上的无凭据代理访问该服务。Windows 严格运行时尚未提供，`control.cmd codex` / `claude` 会拒绝启动。

以下命令仅供排障、自动化或没有快捷入口的高级场景使用。AI 绑定不是通过提示词选择的；必须在**控制端**新建 session，再把 AI CLI 的 LingXi MCP 配置改为该 session。

```sh
# 1. 读取已经配对的设备及实际在线状态，记下目标 DEVICE_ID。
node packages/lingxi-mcp/cli.mjs devices --probe true

# 2. 在目标 Windows 设备上验证目录与 Shell，并创建新的固定绑定。
node packages/lingxi-mcp/cli.mjs select \
  --device DEVICE_ID \
  --workdir 'C:\Projects\my-app' \
  --shell 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

# 3. 用上一步输出的 session 生成该 session 的 MCP 配置。
node packages/lingxi-mcp/cli.mjs config --session NEW_SESSION
```

第三步会输出包含 `NEW_SESSION` 的 Codex/Claude MCP 配置。将其替换当前 AI CLI 中原有 LingXi 服务配置后，完全退出并重新启动 AI CLI；在新对话的第一条任务要求调用 `remote_target`，核对返回的 `deviceId`、目录和 Shell。不要手工修改 session JSON、MCP 的 `--session` 参数或工具调用来“切换”目标。

只改 AI 的工作目录时也必须重复这三步中的 `select` 和 `config`；已有 session 保持原目录。手动持续终端则在启动时填写工作目录，或在终端内使用远端 Shell 的 `cd`；`cd` 仅影响该 PTY，文件扩展命令仍以创建终端时的绑定目录为根。

## 工具与结果

| 工具 | 必填参数 | 行为 |
| --- | --- | --- |
| `remote_target` | 无 | 当前设备身份、目录、Shell、连接状态 |
| `remote_read` | `requestId`, `path` | 读取 UTF-8 文件 |
| `remote_write` | `requestId`, `path`, `content` | 原子创建/覆盖，父目录须已存在 |
| `remote_delete` | `requestId`, `path` | 删除文件或空目录，不递归删除 |
| `remote_list` | `requestId`, `path` | 列目录；根目录使用 `.` |
| `remote_exec` | `requestId`, `command` | 在固定目录与 Shell 执行；可传 `timeoutMs` |
| `remote_tasks` | 可选 `taskId` | 当前 selection 的最近 100 条任务或单任务详情 |
| `remote_cancel` | `taskId` | 请求取消；以最终 `CANCELLED` 为确认 |

每个操作保存 taskId、设备、会话、绑定版本、目标路径/命令、时间、状态、stdout/stderr 和结果。`requestId` 相同且内容相同返回原记录，内容不同返回冲突；想手动重试须使用新 requestId。取消也支持 MCP `notifications/cancelled`。进度以 MCP progress 通知回传；客户端未请求进度时仍记录输出。

文件限制 128 KiB UTF-8，目录最多 1000 项，命令输出最多 1 MiB，默认超时 120 秒、最大一小时。超限有明确错误；不静默截断为成功。命令为非交互执行，stdin 关闭。文件路径限制在绑定目录内，拒绝 `..` 和符号链接越界；Shell 命令以当前用户权限运行，工作目录不是操作系统沙箱。不要将路径检查当作抵御同一用户并发替换目录的隔离机制。

正常退出码 0 为 `SUCCESS`，非零为 `FAILED`；取消为 `CANCELLED`，超时为 `TIMED_OUT`，超量输出为 `OUTPUT_LIMIT`，断线或结果无法确认为 `UNKNOWN`。Unix 终止独立进程组，Windows 使用 Job Object。主动脱离进程组/Job 的守护程序不属于支持的命令生命周期。

## 查看记录与恢复

```sh
node packages/lingxi-mcp/cli.mjs tasks
node packages/lingxi-mcp/cli.mjs tasks --session SESSION_ID
```

控制端的 `tasks.sqlite` 为完整记录，`tasks.json` 为最近 30 条任务的轻量快照（每个输出流只保留末尾 512 字符）。Obsidian 命令面板选择“远程模型任务”，选择控制端，再填写控制端的 `tasks.json` 绝对路径即可查看。此入口复用 Obsidian→控制端的文件传输，不转发控制端→被控制端的执行。

连接断开后当前操作保留已收输出、标为 UNKNOWN；服务不自动重连或重放。重新启动相同 selection 会建立新的远程会话，旧的 QUEUED/RUNNING 记录恢复为 UNKNOWN；已记录 requestId 继续去重。快照有保存时间，控制端异常退出时旧快照可能仍显示 RUNNING，需结合连接情况判断，不能视作实时状态。

## 手动控制命令参考

以下命令适合熟悉命令行的用户，在安装目录执行。`node` 需要在当前终端可用；若由安装脚本自动下载，可使用向导输出的 Node 完整路径。`SESSION` 替换为配置生成的会话 ID。

```sh
node packages/lingxi-mcp/cli.mjs devices --probe true
node packages/lingxi-mcp/cli.mjs shell
node packages/lingxi-mcp/cli.mjs exec --session SESSION --command "pwd"
node packages/lingxi-mcp/cli.mjs list --session SESSION --path .
node packages/lingxi-mcp/cli.mjs upload --session SESSION --local ./example.bin --path example.bin
node packages/lingxi-mcp/cli.mjs download --session SESSION --path example.bin --local ./download.bin
```

`shell` 让用户选择设备，工作目录和 Shell 回车即可使用被控制端检测出的默认值，也可修改；随后建立一个目标设备上的持续交互 PTY。普通输入、方向键、Ctrl+C 和窗口尺寸按字节透传，`cd` 会保持在该终端内。按 `Ctrl+]` 进入控制命令入口后可使用 `/ls`、`/upload`、`/download`、`/exit`；这样远端前台程序收到的 `/upload` 文本不会被控制端截获。文件扩展命令使用创建终端时的不可变设备和目录绑定，绝不根据路径、显示名称或最近设备选择目标。

单文件上限 64 MiB，包含二进制和空文件；目录递归传输暂不提供。默认拒绝覆盖，显式 `--overwrite true` 才替换。同目录暂存完成后提交；断线清理失败会报告暂存文件名。硬链接提交要求目标与工作目录同一文件系统，否则失败并保持原文件。远程路径限于绑定目录，连接失败不在本机执行。每个会话一次只允许一个 CLI/MCP 进程，另开会话可避免锁冲突；Agent 同时只执行一条结构化命令。

MCP 旧的 UTF-8 读写接口仍限 128 KiB。`select --device DEVICE_ID` 可直接采用检测出的默认目录和 Shell；传入 `--workdir PATH --shell PATH` 可更换，生成新会话后重新接入模型。已有会话的绑定保持不变。MCP 服务只提供固定远端工具；它不能从技术上移除 Codex/Claude 自带的本地工具，部署时必须以受限工具配置运行，并用绕过测试确认模型没有额外的本地执行、文件或其他设备入口。

旧版 `init/pair/select/serve/tasks/config` 保留，详见 [进阶文档](REMOTE_TASKS.md)。协议探测返回实际在线状态，旧 Agent 不支持新接口时应升级。

快捷入口也支持参数，例如 `bash control.sh --home /absolute/profile`；Windows 可在终端执行 `control.cmd --home C:\Profiles\remote`。自定义过配置目录时，请使用相同的 `--home`。

## 开发验证

在 `packages/remote` 目录执行：

```sh
pnpm build
pnpm test
cargo fmt --check --manifest-path agent/Cargo.toml
cargo test --locked --manifest-path agent/Cargo.toml
cargo build --locked --manifest-path agent/Cargo.toml
pnpm test:e2e
node scripts/setup.e2e.mjs
```

集成测试在临时配置目录运行真实 Agent 和控制端，验证配对、默认路径、覆盖路径、身份保留及文件与命令操作，不调用付费模型。
