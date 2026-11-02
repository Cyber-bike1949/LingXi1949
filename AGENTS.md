# Monorepo Guidelines

This repository contains three packages:

- `packages/obsidian-plugin`: the Obsidian plugin and its native PTY backend.
- `packages/remote`: the Agent, controller CLI, MCP service and remote release package.
- `packages/core`: internal shared protocol, identity, pairing and filesystem operations.

Use Simplified Chinese for user communication and English for code comments. Build and test packages independently. Obsidian releases must validate and publish root-level `main.js`, `manifest.json`, and `styles.css`, plus platform packages. Preserve device identities and existing configuration. Use Conventional Commit subjects.
