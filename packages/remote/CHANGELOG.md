# Remote Product Changelog

## [5.0.9] - 2026-11-19

- Include the selected device connection ticket in the AI binding marker so the plugin can browse the remote workspace without pairing the device again.

## [5.0.8] - 2026-11-19

- Emit a hidden terminal marker while a bound Codex or Claude session is active so Obsidian can show and transfer files to the selected remote working directory.
- Include the terminal binding protocol in published Remote and MCP packages.

## [5.0.7] - 2026-11-19

- Keep strict Codex sessions compatible with current Codex CLI versions by removing the unsupported `--no-daemon` argument.
- Make the real loopback PTY test use isolated temporary work directories so parallel Rust tests do not race for the controller's home directory.
- Update the installer, package metadata, and documentation to the 5.0.7 release line.
