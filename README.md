<img src="assets/logo.png" width="150" alt="LingXi1949 logo" />

# LingXi1949

**Notes are the best friend you and your agent have.**

English / [简体中文](./README_ZH.md)

## Work without the friction

<table>
  <tr>
    <td width="50%">
      <img src="assets/remote_terminal_en.png" alt="Connect to a local or remote terminal with one click" />
    </td>
    <td width="50%">
      <img src="assets/easy_agent_en.png" alt="Send notes and context to a terminal agent with one click" />
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="assets/operate.gif" width="980" alt="LingXi1949 operation demo" />
    </td>
  </tr>
</table>

## Main interface

<img src="assets/main-interface.png" width="980" alt="LingXi1949 main interface demonstration" />

## Linux Agent

First-time setup requires a few simple steps:

```bash
useradd -m cow

sudo usermod -aG sudo cow

passwd cow

su - cow
```

On Linux x64, run the installer as the ordinary user who will own the remote shell:

```bash
curl -fsSL https://raw.githubusercontent.com/Cyber-bike1949/LingXi1949/main/agent/packaging/install-linux.sh | bash
```

When installation finishes, use the connection code to add the device in LingXi1949.

## Windows Agent

Download the [Windows x64 Agent](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe) and its [SHA-256 checksum](https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download/lingxi1949-win32-x64.exe.sha256).

Alternatively, run the following commands in PowerShell to download, verify, and start the Agent:

```powershell
$baseUrl = 'https://github.com/Cyber-bike1949/LingXi1949/releases/latest/download'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe" -OutFile 'lingxi1949.exe'
Invoke-WebRequest "$baseUrl/lingxi1949-win32-x64.exe.sha256" -OutFile 'lingxi1949.exe.sha256'
$expectedHash = (Get-Content 'lingxi1949.exe.sha256').Split()[0]
$actualHash = (Get-FileHash '.\lingxi1949.exe' -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'SHA-256 verification failed' }
.\lingxi1949.exe run
```

Keep the Agent running, then use its connection code to add the device in LingXi1949.

## Usage

> **Core flow:** choose a device → open a terminal → send note context to an AI CLI agent.

### Open a local or remote terminal

- Run **LingXi1949: Open terminal** from the Obsidian command palette to open the device home.
- Select **This device** to start a local shell immediately.
- To use a remote shell, add a device with the connection code printed by the Agent, then select its device card.

### Give note context to an agent

- Use the command palette to send the current note, editor selection, or current note path.
- When sending a note, LingXi1949 can collect the notes it links to. You can also include recursively discovered backlinks from settings.
- Start Claude Code, Codex, or OpenCode from the workflow launcher and continue with the transferred context.

<img src="assets/one_click.png" width="980" alt="Send note context to a terminal with one click" />

### Transfer files between the vault and a terminal

- Drag Obsidian files into the terminal or directory tree to transfer them to the active local or remote device.
- Browse, drag, or copy files and folders in the terminal directory tree, and copy entries back into a chosen vault folder.
- Modification markers and per-file transfer receipts show which content was synchronized successfully.

<img src="assets/drag_and_drop.png" width="980" alt="Drag files between the vault and a terminal" />

### Reuse terminal operations

- Open **Operation history** from the terminal pane menu to review shell operations entered during the current session.
- Save frequently used operations as a device-specific shortcut group, then run them again from a terminal menu or device card.
- Add terminal-output match conditions when a step must wait for an interactive CLI. Replay pauses when completion cannot be confirmed instead of silently resending a step.

## Current terminal features

- **Directory tree transfers:** browse local or remote directories, transfer files or folders, and drop onto an explicit target path.
- **Modification markers:** only files confirmed by a successful transfer receipt are marked. Clicking or dragging acknowledges the current version; folder markers aggregate marked descendants.
- **Operation history:** open a terminal pane menu and choose **History** to review user-entered shell operations for that session.
- **Shortcut groups:** save selected history entries as a device-specific group, then run the latest group from a terminal pane or a new terminal on its device. Device ownership is checked and uncertain completion pauses the run.
- **Transfer receipts:** supported Agents report per-file success, failure, or unknown status; older Agents remain compatible.

Shortcut replay never treats an uncertain completion as success or silently resends a step.

## Compatibility and verification

New directory metadata and per-file receipt fields are optional, so older peers remain usable. Verify the Agent connection, shell identity (`hostname` and `pwd`), and a sample note transfer before using real content. Full AI TUI readiness and shell-history edge cases still require verification on the target host.
