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

点击下面的页签手动翻页；展开新页时，上一页会自动收起。

<details name="highlights" open>
<summary><strong>1 / 4 · 在 Obsidian 中使用完整终端</strong></summary>

在工作区内打开本机或远程 Shell，一边查看笔记，一边运行 Claude Code、Codex、OpenCode 等 AI CLI 工具。

<img src="assets/main-interface.png" width="980" alt="LingXi1949 主界面与终端工作区" />

</details>

<details name="highlights">
<summary><strong>2 / 4 · 一键把笔记上下文交给 Agent</strong></summary>

发送当前笔记、选中内容或笔记路径；发送整篇笔记时，还可以收集其引用笔记和反向链接笔记。

<img src="assets/one_click.png" width="980" alt="一键将笔记上下文发送到终端" />

</details>

<details name="highlights">
<summary><strong>3 / 4 · 在 Vault 与终端之间拖放文件</strong></summary>

从 Obsidian 向本机或远程设备传输文件，也可以通过终端目录树把文件送回指定 Vault 文件夹。

<img src="assets/drag_and_drop.png" width="980" alt="在 Vault 与终端之间拖拽传输文件" />

</details>

<details name="highlights">
<summary><strong>4 / 4 · 保存并复用工作流</strong></summary>

从状态栏启动 AI 工具或自定义工作流，把常用终端操作保存为设备专属快捷组，需要时一键再次运行。

<img src="assets/termy-settings-workflows.png" width="980" alt="LingXi1949 工作流设置" />

</details>

## 其它主要功能

- **本机与远程终端：** 从设备首页直接打开本机 Shell，或使用连接码添加远程 Windows/Linux 设备。
- **目录树与传输回执：** 浏览本机或远程目录，按文件查看成功、失败或未知状态，减少同步遗漏。
- **修改标记：** 仅对收到成功回执的文件显示标记，文件夹会聚合后代文件的状态。
- **历史操作与快捷组：** 查看当前会话的 Shell 输入，将常用操作保存为设备专属快捷组；无法确认步骤完成时自动暂停。
- **AI 启动器：** 集中启动 Claude Code、Codex 和 OpenCode，并显示工具可用状态。
- **离线与隐私：** 支持离线模式；不包含客户端遥测，不上传使用统计或错误报告。

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
