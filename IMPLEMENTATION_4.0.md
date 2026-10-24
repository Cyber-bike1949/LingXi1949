# 4.0 实施与验收记录

## 迭代一：Agent 结构化任务协议

- 在现有 `termy/terminal/1` 连接上增加 `0x20` JSON 任务帧，不新增远程服务或传输协议。
- 固定设备身份、会话、绑定版本、规范化目录和 Shell；返回结果核对身份。
- 支持 UTF-8 文件读写、目录列表、删除文件/空目录；写入采用临时文件和原子重命名。
- 非交互命令分别传送 stdout/stderr，返回退出码，支持超时、取消和进程组清理。
- 每个控制连接最多一个命令运行；不同目标设备独立并发。
- 已通过：文件读写/删除与路径越界单测、符号链接越界单测；真实 loopback QUIC 的绑定、读写、非零退出、双输出流、超时、取消、重复请求测试；TypeScript 类型检查及 Obsidian lint（已有一条英文文案 warning）。
- 未验证：Windows Job Object/原子替换行为、跨物理设备和中继、Obsidian 桌面实际操作。

迭代 tag 使用 `iteration/4.0-pN`，避免中间版本触发正式发布流水线；最终版本使用 `4.0.0`。

## 迭代二：无界面 SDK 与 MCP

- `packages/remote-sdk` 复用插件的帧编解码、配对模型和控制端身份格式，提供可替换的 TransportAdapter。
- `packages/lingxi-mcp` 提供初始化、配对、探测、选择、配置生成、stdio 服务与任务查询命令。
- SQLite 保存不可变绑定、任务日志、请求去重；不同 selection 独立，断线/重启不重放未确认操作。
- 支持模型客户端取消通知和显式取消工具；stdout 专用于 MCP，诊断输出到 stderr。
- 已通过：7 项 MCP 单测；两个真实 Rust Agent 与两个 Node MCP 进程的 16 次跨语言调用，覆盖身份、设备隔离、文件操作、stdout/stderr、退出码、超时、取消、断线、持久记录与快照。
- 已通过现有回归：Agent 102 项、远程模块 209 项、终端模块 191 项、脚本 26 项；插件构建及 bundle smoke check。
- 本机 Codex CLI 0.155.1 的 `mcp add --help` 与官方配置说明已核对；未调用登录后的模型。Claude CLI 当前未安装，因此不宣称两者已完成真实模型端到端验收。
