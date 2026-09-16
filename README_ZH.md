<img src="assets/logo.png" width="150" alt="LingXi1949 logo" />

# LingXi1949

**笔记，才是你和 Agent 之间最好的朋友。**

简体中文 / [English](./README.md)

## 告别繁琐操作

<table>
  <tr>
    <td width="50%">
      <img src="assets/remote_terminal_cn.png" alt="一键连接本地或远程终端" />
    </td>
    <td width="50%">
      <img src="assets/easy_agent_cn.png" alt="一键将笔记与上下文发送给终端 Agent" />
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="assets/operate.gif" width="980" alt="LingXi1949 操作演示" />
    </td>
  </tr>
</table>

## 主界面

<img src="assets/main-interface.png" width="980" alt="LingXi1949 主界面操作演示" />

## Linux Agent
首次使用需要简单配置下
```bash
useradd -m cow

sudo usermod -aG sudo cow

passwd cow

su - cow
```

在 Linux x64 上，以将要使用远程 Shell 的普通用户身份运行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh | bash
```

安装完成后，使用输出的连接码在 LingXi1949 中添加设备。


## Windows Agent

下载 [Windows x64 Agent 安装包](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe)及其 [SHA-256 校验文件](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe.sha256)。

也可以通过 PowerShell 下载、校验并启动 Agent：

```powershell
$baseUrl = 'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe" -OutFile 'lingxi1949.exe'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe.sha256" -OutFile 'lingxi1949.exe.sha256'
$expectedHash = (Get-Content 'lingxi1949.exe.sha256').Split()[0]
$actualHash = (Get-FileHash '.\lingxi1949.exe' -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'SHA-256 verification failed' }
.\lingxi1949.exe run
```

保持 Agent 运行，然后使用输出的连接码在 LingXi1949 中添加设备。

## 用法

> **核心流程：** 选择设备 → 打开终端 → 将笔记上下文发送给 AI CLI Agent。

### 打开本地或远程终端

- 从 Obsidian 命令面板运行“LingXi1949：打开终端”，进入设备首页。
- 使用“本机”卡片直接打开本地 Shell。
- 使用 Agent 输出的连接码添加远程设备，然后点击设备卡片打开远程 Shell。

### 将笔记上下文交给 Agent

- 从命令面板发送当前笔记、编辑器选中内容或当前笔记路径。
- 发送当前笔记时，可一并收集其引用的笔记；设置中还可选择是否包含反向链接笔记。
- 从工作流启动器打开 Claude Code、Codex 或 OpenCode，直接继续处理已发送的上下文。

<img src="assets/one_click.png" width="980" alt="一键将笔记上下文发送到终端" />

### 在 Vault 与终端之间传输文件

- 将 Obsidian 文件拖入终端或目录树，传输到当前的本地或远程设备。
- 在终端目录树中浏览、拖拽或复制文件与文件夹；也可将条目送回 Vault 的指定文件夹。
- 修改标记和逐文件传输回执会帮助你确认哪些内容已成功同步。

<img src="assets/drag_and_drop.png" width="980" alt="在 Vault 与终端之间拖拽传输文件" />

### 复用终端操作

- 从终端窗格菜单打开“历史操作”，查看当前会话中输入的 Shell 操作。
- 将常用操作保存为设备专属快捷组，以后可从终端菜单或设备卡片再次运行。
- 需要等待交互式 CLI 时，可为步骤配置终端输出匹配条件；无法确认完成时，回放会暂停而不是重复发送。

## 当前终端功能

- **目录树传输：** 浏览本地或远程目录，传输文件或文件夹，也可以拖放到指定目标路径。
- **修改标记：** 只有收到传输成功回执的文件才会点亮。点击或拖动文件可确认当前版本；文件夹标记会聚合后代文件。
- **操作历史：** 在终端窗格菜单中选择“历史操作”，查看当前会话中的用户 Shell 输入。
- **快捷组：** 将选中的历史操作保存为设备专属快捷组，可从终端菜单或设备卡片启动运行。执行前会校验设备归属，无法确认完成时会暂停。
- **传输回执：** 支持的 Agent 会按文件报告成功、失败或未知状态；旧版 Agent 仍可使用。

快捷组回放不会把不明确的完成状态判定为成功，也不会静默重复发送步骤。

## 兼容性与首次验证

新目录元数据和逐文件回执都是可选字段，因此兼容旧版端。首次部署时，请先验证 Agent 连接、Shell 身份（`hostname` 和 `pwd`）以及一份示例笔记传输，再处理真实内容。完整 AI TUI 就绪信号和复杂 Shell 历史场景仍需在目标宿主环境验证。
