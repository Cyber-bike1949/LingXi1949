# LingXi1949 Architecture

## Repository topology

This monorepo contains three product boundaries:

- `packages/obsidian-plugin`: the Obsidian plugin, its TypeScript UI/services, and the native PTY backend.
- `packages/remote`: the LingXi Agent, controller CLI, MCP server, installers, and remote release package.
- `packages/core`: shared protocol, identity, pairing, and filesystem operations. It must remain independent of the products that consume it.

`packages/orchestrator` is an additive local control-plane package. It stores approved task contracts and evidence, dispatches existing Remote/AI/Actions capabilities, and must not change manual control, pairing, persistent PTY, or strict AI bindings.

## Execution boundaries

```text
Obsidian plugin / task progress panel
        ↓ existing authenticated Iroh file-transfer channel (read-only status mirror)
LingXi Agent on the controlled device
        ↑ sanitized snapshots over existing LingXi session
Orchestrator on the controller (task state, locks, evidence)
        ↓                          ↓
AI CLI with existing MCP binding   GitHub Actions
        ↓                          ↓
LingXi Remote controller ─────→ Linux/Windows runners
        ↓
Remote Agent on controlled device
```

Remote sessions bind a device, work directory, and shell. Parallel development therefore uses distinct Git worktrees. The same canonical worktree must never be modified by multiple task sessions.

The orchestrator stays on the controller so Codex/Claude credentials and GitHub credentials do not need to move to the controlled device. The controlled device's existing Agent hosts only a durable, read-only task snapshot outside the project checkout. Obsidian reads it over the paired device connection; it does not make direct public HTTP requests or replace existing terminal, manual-control, or AI CLI bindings.

## Build and test boundaries

- Plugin: `pnpm build:plugin`, `pnpm lint:plugin`, `pnpm test:plugin`.
- Remote: `pnpm build:remote`, `pnpm test:remote`, `pnpm test:e2e:remote` plus Rust checks in its own package instructions.
- Core changes require validation through both plugin and Remote consumers.
- Orchestrator: `pnpm build:orchestrator`, `pnpm test:orchestrator`; its runtime requires Node 24 because it uses `node:sqlite`.

The existing GitHub workflows provide Monorepo CI, real Obsidian UI validation, and separate plugin/Remote release lines. Real UI testing is dispatch-driven and must be correlated with the precise delivery SHA.

## Release boundary

RC artifacts and formal releases are different security domains. Formal plugin tags must be stable `x.y.z`; formal Remote tags must be stable `remote-x.y.z`. Formal release credentials belong only in protected GitHub Environments. No automation may create a formal release without a recorded user approval.
