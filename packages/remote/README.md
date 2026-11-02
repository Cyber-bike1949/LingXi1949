# LingXi Remote 5.0

远程设备子包：主控终端、被控 Agent、Codex/Claude MCP 接入。Obsidian 插件在本仓库的 `packages/obsidian-plugin`，共同协议在本仓库的 `packages/core`。无须运行 Obsidian 即可使用本项目。

## 首次使用

下载并解压与设备匹配的完整平台包，保留解压目录（工具配置使用绝对路径）。Linux x64 运行 `bash scripts/setup.sh`；Windows x64 在 PowerShell 运行 `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1`。脚本自动补齐 Node.js 24 与生产依赖。

1. 被控端选择 `target`。脚本启动 Agent，显示连接码。
2. 主控端选择 `controller`，粘贴连接码、填写目标设备工作目录和 Shell 的绝对路径（Linux 例如 `/bin/sh`，Windows 例如 `C:\Windows\System32\cmd.exe`）。
3. 选择 Codex、Claude 或两者；脚本安装缺失工具并添加 MCP 配置。账号登录仍需人工完成；选择 `none` 仅配置手动控制。
4. 使用脚本输出的命令进入手动控制。日志和结果位于 `~/.lingxi-mcp`。

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

`shell` 让用户选择设备、工作目录和 Shell；输入普通文本执行命令，`/ls`、`/upload`、`/download`、`/exit` 完成文件操作或退出。每条命令独立执行，`cd` 不会改变下一条命令的固定工作目录。首期不是 vim 等全屏程序使用的交互式 PTY。

单文件上限 64 MiB，包含二进制和空文件；目录递归传输暂不提供。默认拒绝覆盖，显式 `--overwrite true` 才替换。同目录暂存完成后提交；断线清理失败会报告暂存文件名。硬链接提交要求目标与工作目录同一文件系统，否则失败并保持原文件。远程路径限于绑定目录，连接失败不在本机执行。每个会话一次只允许一个 CLI/MCP 进程，另开会话可避免锁冲突；Agent 同时只执行一条结构化命令。

MCP 旧的 UTF-8 读写接口仍限 128 KiB。旧版 `init/pair/select/serve/tasks/config` 保留，详见 REMOTE_TASKS.md。协议探测返回实际在线状态，旧 Agent 不支持新接口时应升级。

## 构建和验证

Node.js 24+、pnpm 10.33.4、Rust 1.97.1：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
cargo test --locked --manifest-path agent/Cargo.toml
cargo build --locked --manifest-path agent/Cargo.toml
pnpm test:e2e
node scripts/setup.e2e.mjs
cargo build --release --locked --manifest-path agent/Cargo.toml
pnpm package
```

包在 `release-assets/`，含 Agent、SDK、MCP/手动入口、首次配置脚本及 SHA-256。CI 的测试包使用 debug Agent；正式发布流程构建 release Agent。共用库是版本化源码快照，不需要旁边存在插件仓库。macOS 等平台留有适配边界，尚未交付支持。

自动配置依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude MCP 文档](https://code.claude.com/docs/en/mcp)。安装版本固定为 Codex 0.166.0、Claude Code 2.1.316；已安装工具优先复用。配置成功不代表账号登录和真实模型调用已通过验收。
