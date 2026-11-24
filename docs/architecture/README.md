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

## v6 Orchestrator durability and release controls

The additive `packages/orchestrator` worker persists quota waits, wake-up times, notification outbox entries, task events, and execution locks in SQLite. Task state transitions and corresponding outbox entries commit together. Quota recognition requires explicit limit evidence; ordinary process failures remain failures. A background timer wakes due quota waits and retries Feishu delivery while task subprocesses run, so long AI/Actions stages do not delay scheduling or notifications. A running task renews its per-task lease while external work is in flight, so it does not become claimable merely because an initial lease expired; if renewal fails, the runner stops before starting another stage. Worker startup runs recovery before scheduling. Read-only verification nodes (`git-verify`, `ci`, `rc`) and repeatable local quality checks (`local-verify`) return to `PENDING`; the workflow waiter re-queries the recorded SHA. Interrupted stages with ambiguous external side effects remain `UNKNOWN`, block the task, and enqueue a notification instead of being replayed.

Formal publication is controlled by the approved task contract. Release retry treats a remote tag at the already-verified SHA as an existing trigger, rejects a tag at another SHA, and records `RELEASED` only after required release workflows pass and GitHub returns a published, non-draft Release for the exact tag. The approved v6.0 baseline authorizes release after every required gate succeeds, without a second experience-approval step. When `runtime.release.autoAfterGate` is enabled, the project must explicitly set `approvedBy` as an auditable reference to that authorization; the worker records it before starting a formal release. RC creation remains downstream of required local, E2E, and Actions gates. Missing release configuration or approval reference must stop automation.

The Orchestrator package README documents configuration and operating commands. Its dashboard is an authenticated controller view; the Obsidian panel consumes only the existing encrypted file-transfer status mirror. Neither is a replacement for the task database or the LingXi device/session authorization boundary.

The Obsidian task mirror carries event IDs, timestamps, inferred stage duration, severity-relevant fields, and a bounded recent history. The read-only view filters by stage or error and supports keyword search with incremental rendering; when transfer fails it retains the last snapshot and labels the connection as interrupted with the last successful local sync time. Full events remain in controller SQLite; the device mirror intentionally reports when its event window is truncated.


Controller-local Codex sessions can be checkpointed when JSONL events expose the native thread ID. The Orchestrator writes each session ID to the task event log as it arrives and can substitute it into project-configured resume arguments on a later attempt. Native resume is opt-in and cannot be combined with ephemeral execution; approved documents and durable task events remain the fallback checkpoint. Remote AI processes still return one final LingXi result and do not stream native session identifiers.
