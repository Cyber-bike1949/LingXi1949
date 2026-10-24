# 远程模型任务（4.0）

A 的 Obsidian 是操作窗口，B 运行 Codex/Claude 与 `lingxi-mcp`，C/D 运行升级后的 LingXi Agent。B 直接连接目标设备；文件不自动同步到 B。

## 安装与首次使用

B 需要 Node.js 24（使用内置 SQLite）、pnpm 和本仓库。C 需要本版本 Agent，不需要模型 CLI。

```sh
pnpm install --frozen-lockfile
pnpm build:mcp
cargo build --release --locked --manifest-path agent/Cargo.toml
```

将构建好的 Agent 部署到 C，按既有方式启动并取得连接码。以下命令在 B 的终端执行（可以从 A 的灵犀终端输入）：

```sh
node packages/lingxi-mcp/cli.mjs init
node packages/lingxi-mcp/cli.mjs pair --name C --ticket-file /path/to/c-ticket.txt
node packages/lingxi-mcp/cli.mjs devices --probe true
node packages/lingxi-mcp/cli.mjs select --device DEVICE_ID --workdir /workspace/app --shell /bin/bash
```

`pair` 保存连接码中的设备身份；`select` 实际连接并检查工作目录和 Shell，返回新的 `session`。该选择不可变，模型工具没有切换设备的参数。Windows 目标应提供 Shell 的绝对路径，例如 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。

默认数据目录是 B 的 `~/.lingxi-mcp`；所有命令支持 `--home /absolute/path`。`profile.json` 保存 B 自己的控制端身份与配对设备；不会读取 A 的 Obsidian 身份。连接码沿用既有 LingXi 信任语义，不是新增的双向人工批准或设备 ACL。

既有 Agent 同时只允许一个控制连接。B 连接 C 前，需要先关闭 A→C 的连接；A→B 的终端可以继续使用。不同模型会话可分别绑定 C、D 并发；同一目标同时只运行一个命令，冲突返回 `DEVICE_BUSY`。同一个 selection 不可被两个 MCP 进程同时打开。

## 接入模型 CLI

先生成包含实际 Node 与脚本绝对路径的配置资料：

```sh
node packages/lingxi-mcp/cli.mjs config --session SESSION_ID
```

Codex 的配置放在 B 的 `~/.codex/config.toml`，例：

```toml
[mcp_servers.lingxi]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/LingXi1949/packages/lingxi-mcp/cli.mjs", "serve", "--session", "SESSION_ID"]
startup_timeout_sec = 180
tool_timeout_sec = 3660
```

也可用 `codex mcp add lingxi -- /absolute/path/to/node /absolute/path/to/LingXi1949/packages/lingxi-mcp/cli.mjs serve --session SESSION_ID` 注册，再调整上述超时。使用 `/mcp` 检查连接。配置格式和超时字段依据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

Claude Code 在 B 注册：

```sh
claude mcp add --transport stdio lingxi -- /absolute/path/to/node /absolute/path/to/LingXi1949/packages/lingxi-mcp/cli.mjs serve --session SESSION_ID
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

B 的 `tasks.sqlite` 为完整记录，`tasks.json` 为最近 30 条任务的轻量快照（每个输出流只保留末尾 512 字符）。A 的 Obsidian 命令面板选择“远程模型任务”，选 B，再填写 B 的 `tasks.json` 绝对路径即可查看。此入口复用 A→B 的文件传输，不转发 B→C 的执行。

连接断开后当前操作保留已收输出、标为 UNKNOWN；服务不自动重连或重放。重新启动相同 selection 会建立新的远程会话，旧的 QUEUED/RUNNING 记录恢复为 UNKNOWN；已记录 requestId 继续去重。快照有保存时间，B 异常退出时旧快照可能仍显示 RUNNING，需结合连接情况判断，不能视作实时状态。

## 开发验证

```sh
pnpm build:mcp
pnpm test:mcp
cargo test --manifest-path agent/Cargo.toml
cargo build --manifest-path agent/Cargo.toml
node packages/lingxi-mcp/e2e.mjs
pnpm lint:obsidian
pnpm build
pnpm test:remote
pnpm test:terminal
```

`e2e.mjs` 在临时配置目录启动两个真实 Rust Agent 和两个 Node MCP 控制端，通过 loopback QUIC 检查身份、设备隔离、文件、命令、取消和断线。不访问用户真实项目，不调用付费模型。测试结果与未测项见 [实施记录](IMPLEMENTATION_4.0.md)。
