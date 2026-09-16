<img src="assets/logo.png" width="150" alt="LingXi1949 logo" />

# LingXi1949

English / [简体中文](./README_ZH.md)

**Stop moving context by hand: send notes to your agent in one click.**

<table>
  <tr>
    <td width="50%">
      <img src="assets/remote_terminal_en.png" alt="Connect to a local or remote terminal with one click" />
    </td>
    <td width="50%">
      <img src="assets/easy_agent_en.png" alt="Send notes and context to a terminal agent with one click" />
    </td>
  </tr>
</table>

## Core highlights

Select a tab below to turn the page. Opening a new page automatically closes the previous one.

<details name="highlights" open>
<summary><strong>1 / 4 · A complete terminal inside Obsidian</strong></summary>

Open a local or remote shell in your workspace, keep your notes in view, and run AI CLI tools such as Claude Code, Codex, and OpenCode.

<img src="assets/main-interface.png" width="980" alt="LingXi1949 main interface and terminal workspace" />

</details>

<details name="highlights">
<summary><strong>2 / 4 · Give note context to an agent in one click</strong></summary>

Send the current note, a selection, or the note path. A full-note transfer can also collect linked notes and backlinks.

<img src="assets/one_click.png" width="980" alt="Send note context to a terminal with one click" />

</details>

<details name="highlights">
<summary><strong>3 / 4 · Drag files between a vault and a terminal</strong></summary>

Transfer Obsidian files to a local or remote device, or use the terminal directory tree to send files back to a chosen vault folder.

<img src="assets/drag_and_drop.png" width="980" alt="Drag files between a vault and a terminal" />

</details>

<details name="highlights">
<summary><strong>4 / 4 · Save and reuse workflows</strong></summary>

Launch AI tools or custom workflows from the status bar, and save frequent terminal operations as device-specific shortcut groups to run again later.

<img src="assets/termy-settings-workflows.png" width="980" alt="LingXi1949 workflow settings" />

</details>

## More features

- **Local and remote terminals:** open a local shell from the device home, or add a remote Windows/Linux device with its connection code.
- **Directory tree and transfer receipts:** browse local or remote directories and see per-file success, failure, or unknown states.
- **Modification markers:** mark only files confirmed by a successful receipt, with folder states aggregated from descendants.
- **History and shortcut groups:** review shell input from the current session and save reusable, device-specific operation groups. Replay pauses when step completion is uncertain.
- **AI launcher:** start Claude Code, Codex, and OpenCode from one place and see whether each tool is available.
- **Offline mode and privacy:** work offline when needed. LingXi1949 has no client-side telemetry and sends no usage analytics or error reports.

## Installation

LingXi1949 supports Obsidian Desktop only.

### Install the plugin

The recommended route is Obsidian Community Plugins:

1. Open **Settings → Community plugins** and turn off **Restricted mode** if it is enabled.
2. Select **Browse** and search for `LingXi`.
3. Install and enable **LingXi1949**.

For earlier access to the latest tagged build, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add `Cyber-bike1949/LingXi1949`.

### Use a local terminal

Run **LingXi1949: Open terminal** from the Obsidian command palette and choose **This device**. Install and sign in to AI CLI tools such as Claude Code, Codex, or OpenCode separately on this computer.

### Connect a remote Linux Agent

On Linux x64, run the installer as the ordinary user who will own the remote shell:

```bash
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh | bash
```

The script downloads and verifies the Agent, starts its user service, and displays a connection code. Paste the code into the plugin's **Add device** entry. If no code appears, run `~/.local/bin/lingxi1949 status`.

### Connect a remote Windows Agent

Download the [Windows x64 Agent](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe) and its [SHA-256 checksum](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe.sha256), or run this block in PowerShell:

```powershell
$baseUrl = 'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe" -OutFile 'lingxi1949.exe'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe.sha256" -OutFile 'lingxi1949.exe.sha256'
$expectedHash = (Get-Content 'lingxi1949.exe.sha256').Split()[0]
$actualHash = (Get-FileHash '.\lingxi1949.exe' -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'SHA-256 verification failed' }
.\lingxi1949.exe run
```

Keep the Agent running, then add the device with its connection code. Before using real content, verify `hostname` and `pwd` (`Get-Location` in PowerShell) and transfer a sample note that contains no personal information.

> Be water, my friend! — Bruce Lee（活得像水一样吧，朋友。）
