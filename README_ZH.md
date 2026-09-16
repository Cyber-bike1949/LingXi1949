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

## 核心亮点

点击任意预览图可查看原图。

<table>
  <tr>
    <td width="50%">
      <a href="assets/main-interface.png"><img src="assets/main-interface.png" alt="LingXi1949 主界面与终端工作区" /></a><br />
      <strong>在 Obsidian 中使用完整终端</strong><br />让笔记与本机或远程 Shell 留在同一个工作区。
    </td>
    <td width="50%">
      <a href="assets/one_click.png"><img src="assets/one_click.png" alt="一键将笔记上下文发送到终端" /></a><br />
      <strong>一键把完整上下文交给 Agent</strong><br />无需复制粘贴，即可发送笔记、选中内容、路径、引用与反链。
    </td>
  </tr>
  <tr>
    <td width="50%">
      <a href="assets/drag_and_drop.png"><img src="assets/drag_and_drop.png" alt="在 Vault 与终端之间拖拽传输文件" /></a><br />
      <strong>不离开 Obsidian 也能传文件</strong><br />在 Vault 与终端目录树之间直接拖放文件和文件夹。
    </td>
    <td width="50%">
      <a href="assets/termy-settings-workflows.png"><img src="assets/termy-settings-workflows.png" alt="LingXi1949 工作流设置" /></a><br />
      <strong>保存并复用工作流</strong><br />把重复的终端操作变成设备专属快捷组。
    </td>
  </tr>
</table>

## 其它主要功能

- **远程连接不再折腾网络：** 用连接码配对 Windows 或 Linux 设备，无需注册账号、申请公网 IP 或开放入站端口；优先点对点直连，必要时才使用加密中继。
- **多项任务互不打扰：** 同时连接多台设备，并为每台设备打开多个独立终端；某个会话断开或关闭，不影响其它工作。
- **不用再手抄文件路径：** 双击目录，终端自动进入该目录；双击文件，路径自动插入 AI TUI 光标处，也支持直接拖拽。
- **笔记直接送到工作目录：** 把笔记拖进终端或目录树，并保留 Vault 相对结构；逐文件回执与修改标记会告诉你哪些内容确实送达。
- **一次交给 Agent 完整上下文：** 一键发送当前笔记、选中内容或路径，还可自动收集引用笔记与多层反链，减少遗漏。
- **重复操作只做一次：** 从会话历史保存设备专属快捷组，之后一键回放；无法确认上一步完成时会暂停，不会盲目连续输入。
- **AI 工具随你选择：** 集中启动 Claude Code、Codex 或 OpenCode，开始前即可看到工具是否可用。
- **私密内容不做数据生意：** 离线模式会关闭可选网络检查；不包含客户端遥测，不上传使用统计或错误报告。

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

在 Linux x64 设备上，以将要使用远程 Shell 的普通用户身份运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh | bash
```

脚本会下载并校验 Agent、启动用户服务并显示连接码。将连接码粘贴到插件的“添加设备”入口。若未看到连接码，可运行 `~/.local/bin/lingxi1949 status` 查询状态。

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

> 活得像水一样吧，朋友。—— 李小龙（Be water, my friend!）
