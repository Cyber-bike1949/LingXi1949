<div align="center">

<img src="assets/logo.png" width="150" alt="LingXi1949 logo" />

# LingXi1949

连接本地与远程设备，并将笔记上下文交给 AI CLI Agent 的 Obsidian 终端工作台。

**笔记，才是你和 Agent 之间最好的朋友。**

简体中文 / [English](./README.md)

## 告别繁琐操作

<table>
  <tr>
    <td width="50%" align="center">
      <img src="assets/remote_terminal_cn.png" alt="一键连接本地或远程终端" />
    </td>
    <td width="50%" align="center">
      <img src="assets/easy_agent_cn.png" alt="一键将笔记与上下文发送给终端 Agent" />
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
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

## 插件端使用

输入连接码添加设备，打开终端，即可在 Obsidian 中开始使用。

- Obsidian 笔记和终端中的文件均可通过拖拽，在设备间直接传输。

<img src="assets/drag_and_drop.png" width="980" alt="LingXi1949 main interface demonstration" />

- 当前笔记及其相关引用可一键传输到终端，LingXi1949 会自动查找被引用的笔记并一并传输。

<img src="assets/one_click.png" width="980" alt="LingXi1949 main interface demonstration" />
</div>