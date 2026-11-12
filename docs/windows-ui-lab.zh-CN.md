# Windows 图形化测试机

这台机器用于运行真实 Obsidian 的 Playwright 端到端测试。它不是日常开发机，也不保存真实 Vault、账号或连接码；测试每次都会创建临时 Vault、临时 Agent 身份和临时工作目录。

## 一次性配置

1. 创建专用 Windows 本地账户（例如 `lingxi-test`），使其能保持登录；不要使用个人主账户。
2. 从仓库 **Settings → Actions → Runners → New self-hosted runner** 复制 Windows 安装命令，在该账户的 PowerShell 中执行。
3. 给该 Runner 添加标签 `lingxi-ui`。不要将连接码、GitHub PAT 或任何私密 Vault 放进仓库或 workflow 文件。
4. 保持桌面会话可用。Runner 可以作为服务运行；若某类 Electron 测试需要可见桌面，则以该账户的登录会话启动 Runner。远程桌面仅用于观察和排障，不是测试依赖。

## 运行

在 GitHub Actions 中手动运行 **Real Obsidian UI**，将 `target` 选择为 `lab`。工作流会：

- 构建当前提交的插件与 Agent；
- 下载隔离的 Obsidian；
- 用 Playwright 执行插件加载、本地终端、命令回显、远程设备、断开重连；
- 上传截图、`report.json` 与运行日志作为 artifact。

默认 `hosted` 继续使用 GitHub 托管的 Ubuntu/Windows Runner，因此测试机离线不会阻塞普通 CI。

## 真实设备场景

对真实 Windows Agent 的验收应另设环境变量或 GitHub Environment secret 注入当前连接码；它不能写入仓库。该场景在 Agent 在线时手动运行，并必须使用专用测试目录，例如 `D:\OB\testDemo`。
