<img src="assets/logo.png" width="150" alt="LingXi1949 logo" />

# LingXi1949

简体中文 / [English](./README.md)

**告别上下文搬运：笔记一键交给 Agent。**

<table>
  <tr>
    <td width="50%">
      <img src="assets/remote_terminal_cn.png" alt="一键连接本地或远程终端" />
    </td>
    <td width="50%">
      <img src="assets/easy_agent_cn.png" alt="一键将笔记与上下文发送给终端 Agent" />
    </td>
  </tr>
</table>

## 功能

- **远程连接不再折腾网络：** 用连接码配对 Windows 或 Linux 设备，无需注册账号、申请公网 IP 或开放入站端口；优先点对点直连，必要时才使用加密中继。
- **多项任务互不打扰：** 同时连接多台设备，并为每台设备打开多个独立终端；某个会话断开或关闭，不影响其它工作。
- **不用再手抄文件路径：** 双击目录，终端自动进入该目录；双击文件，路径自动插入 AI TUI 光标处，也支持直接拖拽。
- **笔记直接送到工作目录：** 把笔记拖进终端或目录树，并保留 Vault 相对结构；逐文件回执与修改标记会告诉你哪些内容确实送达。
- **一次交给 Agent 完整上下文：** 一键发送当前笔记、选中内容或路径，还可自动收集引用笔记与多层反链，减少遗漏。
- **重复操作只做一次：** 从会话历史保存设备专属快捷组，之后一键回放；无法确认上一步完成时会暂停，不会盲目连续输入。
- **AI 工具随你选择：** 集中启动 Claude Code、Codex 或 OpenCode，开始前即可看到工具是否可用。
- **私密内容不做数据生意：** 离线模式会关闭可选网络检查；不包含客户端遥测，不上传使用统计或错误报告。

## 2.1 新增功能

使用新的文件操作功能时，请同步更新插件及对应的本机后端或远程 Agent。

- 内置 Claude Code、Codex 和 OpenCode 安装快捷组，可按平台和 Shell 预览命令，也可复制为可编辑的自定义组。
- 连接的本机后端或远程 Agent 支持文件操作时，可在目录树确认删除文件，以及通过内部拖拽移动文件。
- 从设备首页顶部打开“反馈与建议”。浏览器表单支持中英文，只需选择类型、填写内容，可选填联系方式和上传图片。链接携带插件版本、语言和本机系统，版本和系统随反馈保存，无需填写标题或勾选确认框。

## 安装

LingXi1949 仅支持 Obsidian 桌面版。

### 安装插件

推荐从 Obsidian 社区插件市场安装：

1. 打开“设置 → 第三方插件”，关闭“安全模式”（如已开启）。
2. 点击“浏览”，搜索 `LingXi`。
3. 安装并启用 **LingXi1949**。

希望更早使用最新标签版本时，也可以安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)，然后添加仓库 `Cyber-bike1949/LingXi1949`。

### 使用本机终端

从 Obsidian 命令面板运行“LingXi1949：打开终端”，选择“本机”即可。Claude Code、Codex、OpenCode 等 AI CLI 工具需在本机单独安装并登录。

### 连接远程 Linux Agent

当前源码中的安装脚本面向使用 systemd 的 Linux x64（Ubuntu 22.04/24.04 或 Debian 12），下载固定的 `2.1.0` Agent。对应 Release 及校验文件发布后才能成功安装；安装已发布的旧版本时，请使用对应 Git tag 中的安装说明。

先下载脚本，再指定运行远程 Shell 的普通账户：

```bash
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh -o install-linux.sh
sudo bash install-linux.sh --user agentuser
```

将 `agentuser` 替换为目标账户。脚本会按需创建账户、校验下载文件、启动 systemd 用户服务，并打印供“添加设备”使用的连接码。不传 `--user` 时默认为 `monkey`；Agent 本身始终以选定的普通用户运行。对同一账户重复安装会保留设备身份。查询状态时，请以该账户运行 `~/.local/bin/lingxi1949 status`。

本地编译 Agent 的运行方式见[开发指南](docs/development_ZH.md#33-rust-agentlingxi1949)。

### 连接远程 Windows Agent

下载 [Windows x64 Agent](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe) 及其 [SHA-256 校验文件](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe.sha256)，或在 PowerShell 中运行：

```powershell
$baseUrl = 'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe" -OutFile 'lingxi1949.exe'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe.sha256" -OutFile 'lingxi1949.exe.sha256'
$expectedHash = (Get-Content 'lingxi1949.exe.sha256').Split()[0]
$actualHash = (Get-FileHash '.\lingxi1949.exe' -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'SHA-256 verification failed' }
.\lingxi1949.exe run
```

保持 Agent 运行，再使用其输出的连接码添加设备。首次使用时，请先核对 `hostname` 和 `pwd`（PowerShell 使用 `Get-Location`），并用不含个人信息的示例笔记验证传输。

构建与测试说明见[开发指南](docs/development_ZH.md)。

> 活得像水一样吧，朋友。—— 李小龙（Be water, my friend!）
