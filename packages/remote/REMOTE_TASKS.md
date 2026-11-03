# 远程模型任务（5.0）

## 安装与首次使用

推荐复制执行 [首次使用](README.md#首次使用) 中的 **install-remote 一键安装命令**，自动下载、校验、解压平台包并进入初始化。需要对应的 Remote Release 已公开发布（当前发布状态见 README）。也可手动下载完整平台包，Windows x64 双击 `install.cmd`；Linux x64 执行 `bash install.sh`。脚本自动安装运行环境、启动 Agent、配对并配置模型工具，无需手工执行下面的高级命令。

- **被控制端**：存放项目并执行命令，选择默认角色 `1`，把连接码复制给控制端。
- **控制端**：运行 Codex/Claude 与 `lingxi-mcp`，选择角色 `2`，粘贴连接码。工作目录和 Shell 采用被控制端实际检测出的默认值，回车确认即可，也可以更换。
- **Obsidian 操作窗口（可选）**：用于打开终端或查看任务记录，不是必需的第三台设备。控制端直接连接被控制端，文件不自动同步。

默认工作目录为被控制端用户主目录；Shell 优先使用其环境中存在且可执行的 Shell，再尝试系统常见路径。检测不到时需填写绝对路径。建议将工作目录改为实际项目目录，以明确文件操作范围。模型账号登录仍需本人完成。

### 手动初始化（高级用法）

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
