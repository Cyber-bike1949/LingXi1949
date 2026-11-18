# Remote Product Changelog

## [5.0.7] - 2026-11-19

- Keep strict Codex sessions compatible with current Codex CLI versions by removing the unsupported `--no-daemon` argument.
- Make the real loopback PTY test use isolated temporary work directories so parallel Rust tests do not race for the controller's home directory.
- Update the installer, package metadata, and documentation to the 5.0.7 release line.
