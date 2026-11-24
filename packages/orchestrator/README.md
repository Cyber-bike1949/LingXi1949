# LingXi AI R&D Orchestrator MVP

This package is an additive orchestration entry point. It does not replace or modify LingXi manual control, pairing, persistent PTY sessions, or Codex/Claude MCP bindings.

## Prerequisites

- Node.js 24+ and pnpm 10.33.4.
- A pre-existing LingXi controller setup and an existing selected session for the target device.
- A GitHub repository and a checked-out project on the controlled device.

## Minimal project configuration

Use JSON for the MVP so no configuration parser dependency is needed:

```json
{
  "repository": "owner/example-web",
  "developmentBranchPattern": "feat/ai-{taskId}",
  "commands": ["pnpm test", "pnpm build"]
}
```

Copy [`project.example.json`](project.example.json) into the new Web project and replace the repository and commands. Do not put tokens, SSH keys, device pairing information, or an AI login in this file.

For a conventional pnpm Web project, copy [`templates/lingxi-rc.yml`](templates/lingxi-rc.yml) to the target repository's `.github/workflows/lingxi-rc.yml`. Adjust `artifact_path` if the build output is not `dist`. The project configuration's `runtime.workflows.rc` names this workflow and its visible job name, so the orchestrator can dispatch it at the verified SHA and download its artifacts.

The `runtime` section only references an existing LingXi CLI/session and installed AI command. It does not contain credentials and does not replace manual control or the existing AI MCP binding. Codex runs on the controller (`target: "local"`) and uses the existing LingXi MCP binding for project operations. Other supported AI CLIs may run locally or through an existing LingXi session (`target: "remote"`). An optional `agent.mcp` starts a task-scoped LingXi MCP server by passing Codex CLI configuration overrides; this does not write or replace the user's Codex configuration. The prompt explicitly limits local Codex to the bound device's `remote_*` tools for project operations. The controller's Codex login is used; the controlled Windows device does not need a Codex login.

For the Obsidian read-only task panel, optionally configure `runtime.taskMirror`. The orchestrator remains on the controller because that is where the approved AI CLI and GitHub credentials live; after each workflow node it publishes a sanitized snapshot to the already-connected controlled device using LingXi's encrypted file-transfer channel. The Agent-hosted file is a view mirror, not the source of truth, and no new device port is opened:

```json
"taskMirror": {
  "remotePath": ".lingxi-orchestrator\\tasks.json",
  "remoteFinalPath": "D:\\Automation\\LingXi\\orchestrator-status\\tasks.json"
}
```

`remotePath` is a temporary path relative to the selected Agent session's bound directory. `remoteFinalPath` is an absolute path on that same controlled device, outside the project checkout; use a directory writable by the Agent account and configure that exact path in Obsidian's “研发任务进度” panel for the paired device. The transfer uses an atomic replacement and is capped at 512 KiB. The mirror contains task/node/workflow summaries and a test handoff link, not approved requirement bodies, raw AI output, local artifact paths, or credentials. If a mirror write fails, task execution continues and the failure is recorded on the controller; the UI timestamp makes stale mirrors visible.

Before the first real run, use `doctor` (alias: `preflight`) to check the selected LingXi sessions, remote Git, configured AI commands, GitHub authentication, and every named workflow. It neither creates a worktree nor dispatches a workflow. The configuration shape is documented in [`project.schema.json`](project.schema.json):

```sh
node packages/orchestrator/src/cli.mjs preflight --project ./project.json
```

Each remote may include a stable `resourceId` (normally the controlled device ID). It is used for worktree leases, so provide it when more than one LingXi session can reach the same device. If only `runtime.remote` is provided, the test path is automatically placed below `<worktreeRoot>/test/<taskId>` and is still isolated from the development worktree.

## Minimal flow

```sh
pnpm --dir packages/orchestrator build
node packages/orchestrator/src/cli.mjs init
node packages/orchestrator/src/cli.mjs document-draft \
  --kind requirement --input ./raw-request.md --output ./requirement.md \
  --executable codex --args-json '["exec","-"]'
node packages/orchestrator/src/cli.mjs document-draft \
  --kind test-case --input ./requirement.md --output ./test-cases.md \
  --executable codex --args-json '["exec","-"]'
# Review and approve both generated files before creating the task.
node packages/orchestrator/src/cli.mjs task-create \
  --id RND-001 --title "Add health endpoint" --repository owner/example-web \
  --branch feat/ai-RND-001 --base-sha HEAD \
  --approved-by your-name \
  --requirement-file ./requirement.md \
  --test-case-file ./test-cases.md
node packages/orchestrator/src/cli.mjs task-prompt --id RND-001 --project ./project.json
node packages/orchestrator/src/cli.mjs task-plan --id RND-001
node packages/orchestrator/src/cli.mjs rc-request --id RND-001 --version 0.1.0-rc.1
node packages/orchestrator/src/cli.mjs task-run-next --id RND-001 --project ./project.json
```

`document-draft` only creates a draft and prints `approved: false`; it never creates a task or changes its acceptance criteria. Review the Markdown first. `task-create` requires `--approved-by`, reads both approved files, calculates and freezes their byte-level SHA-256 values, and writes the approval identity/time to the immutable event trail. The private orchestrator database retains the approved text so agents receive the exact reviewed requirements and test cases; normal task/list/dashboard responses expose hashes and metadata only.

Run `task-run-next` again after each external stage completes. On the first run it creates the execution plan automatically, then selects the next dependency-ready node in this order: development worktree → development AI → pushed/clean Git SHA verification → independent test worktree → test AI → local quality commands → CI/E2E → RC gate. If configured, E2E dispatches its named workflow against the verified delivery SHA before waiting for its result.

For unattended progression, use `task-run-all`; it repeatedly invokes the same guarded next-node executor and stops after a failure, block, quota wait, RC readiness, or the configured step cap. The task state and quota retry time are persisted, so a restarted worker can resume eligible tasks and wake quota waits when their retry time arrives.

```sh
node packages/orchestrator/src/cli.mjs task-run-all \
  --id RND-001 --project ./project.json --max-steps 10
```

Use `--auto-retry true` to permit up to three repair loops from the development node. Each loop resets all downstream evidence and requires a fresh pushed SHA and fresh CI/E2E results. Without that explicit option, a failed task remains in `FIXING` for inspection. To restart a different point after diagnosing a transient failure, use `task-retry --id RND-001 --from local-verify`; a fourth attempt moves the task to `BLOCKED_USER_DECISION`.

The resulting JSON prompt is the immutable handoff package for a developer or test AI session. `task-remote-exec` uses the existing `lingxi-mcp` CLI and an already-created session; it never changes active manual or AI bindings.

`task-agent-run` starts an explicitly configured AI executable and writes the immutable task package to its standard input. It does not create or overwrite an MCP binding; use the existing LingXi strict AI launcher/configuration first.

```sh
node packages/orchestrator/src/cli.mjs task-agent-run \
  --id RND-001 --project ./project.json --role developer \
  --executable codex --args-json '["exec","-"]'
```

```sh
node packages/orchestrator/src/cli.mjs task-remote-exec \
  --id RND-001 \
  --lingxi-cli /absolute/path/to/packages/remote/packages/lingxi-mcp/cli.mjs \
  --session EXISTING_SESSION_ID \
  --remote-command "git status --short"
```

Use a planned node name to attach the actual remote result to the workflow:

```sh
node packages/orchestrator/src/cli.mjs task-remote-exec \
  --id RND-001 --kind prepare-worktree \
  --lingxi-cli /absolute/path/to/packages/remote/packages/lingxi-mcp/cli.mjs \
  --session EXISTING_SESSION_ID \
  --remote-command "git fetch origin && git worktree add -b feat/ai-RND-001 /worktrees/RND-001 origin/main"
```

The planner creates separate development and test paths: `prepare-worktree` → `develop` → `git-verify` → `prepare-test-worktree` → `test` → `local-verify`, then parallel `ci` / `e2e` and the `rc` gate. The tester is a separate AI process and receives the verified delivery SHA rather than trusting the developer's report. Configure `runtime.remotes.development` and `runtime.remotes.test` for different controlled devices; omit `remotes.test` and the development device is reused with a distinct test worktree.

The worktree and local quality nodes can also be executed directly through an existing LingXi session:

```sh
node packages/orchestrator/src/cli.mjs task-prepare-worktree \
  --id RND-001 --worktree-root /worktrees \
  --lingxi-cli /absolute/path/to/packages/remote/packages/lingxi-mcp/cli.mjs \
  --session EXISTING_SESSION_ID
node packages/orchestrator/src/cli.mjs task-quality-run \
  --id RND-001 --project ./project.json --worktree /worktrees/RND-001 \
  --lingxi-cli /absolute/path/to/packages/remote/packages/lingxi-mcp/cli.mjs \
  --session EXISTING_SESSION_ID
```

## GitHub Actions evidence

The controller needs a minimally scoped `gh` login. The orchestrator queries by the exact delivery SHA and does not treat the latest run as evidence.

```sh
node packages/orchestrator/src/cli.mjs workflow-dispatch \
  --id RND-001 --workflow obsidian-ui.yml --sha <delivery-sha> \
  --input-key target --input-value hosted
node packages/orchestrator/src/cli.mjs workflow-sync \
  --id RND-001 --sha <delivery-sha> \
  --required "Monorepo CI,Real Obsidian UI"
```

`workflow-sync` records every matching run. Missing, queued, cancelled, skipped, timed-out, or failed required workflows cannot pass the `ci` node.

After a successful, recorded workflow run, download its Actions artifacts into the orchestrator evidence directory. The command rejects a run that was not recorded for the task's verified delivery SHA, then stores a deterministic manifest hash with the task.

```sh
node packages/orchestrator/src/cli.mjs workflow-download-artifacts \
  --id RND-001 --run-id 123456789 --gh gh
```

On every worker startup, `recover` reconciles interrupted nodes before scheduling. The read-only verification stages `git-verify`, `local-verify`, `ci`, and `rc` return to `PENDING` and rerun from persisted dependencies; Actions are queried by the recorded SHA. Interrupted stages that may have side effects or need an AI session (`prepare-worktree`, `develop`, `prepare-test-worktree`, `test`, `e2e`, `rc-build`) become `UNKNOWN` and block for evidence-based reconciliation; they are never blindly replayed. Recovery records events and queues a blocked notification. Formal release retries treat an existing remote tag at the verified delivery SHA as already triggered, reject a tag pointing elsewhere, and mark a task `RELEASED` only after required workflows succeed and GitHub reports a published, non-draft Release for that tag. The authenticated dashboard filters raw command output, prompts, credentials, and error text from its event feed.

## Task dashboard and authenticated intake UI

Without a token, the loopback dashboard remains read-only:

```sh
node packages/orchestrator/src/cli.mjs serve --port 43194
```

To enable the task intake UI, first finish and validate a project runtime configuration, then set a random 32+ character `LINGXI_ORCHESTRATOR_TOKEN` and pass `--project`. The UI only accepts requirements/test cases that the operator explicitly approves; repository, branch pattern, base SHA, AI CLI, LingXi sessions and workflows come from the project configuration. The user must separately approve generated requirements before submitting them. Release approval and formal releases remain CLI-only.

```sh
export LINGXI_ORCHESTRATOR_TOKEN="$(openssl rand -hex 32)"
node packages/orchestrator/src/cli.mjs serve --project ./project.json --port 43194
```

Open `http://127.0.0.1:43194/`. Authenticated routes require a Bearer token; the UI keeps it in the current browser tab's session storage. The service binds to loopback by default. Binding to a non-loopback address is refused unless both an auth token and `--tls-terminated true` are supplied; prefer keeping this service loopback-only behind an HTTPS tunnel/reverse proxy. Never expose the task runner over unauthenticated HTTP. `GET /health`, `GET /meta`, `GET /tasks`, and `GET /tasks/:id` are available; authenticated `POST /tasks` requires an explicit approval checkbox and `POST /tasks/:id/run` starts only a task in the configured repository.

## Local worker

Run the scheduler as a local foreground service on the controller when continuous progression is wanted. Configure `runtime.notifications.feishuWebhookEnv` with the name of an environment variable holding the Feishu/Lark HTTPS webhook URL; the URL itself is never saved in project configuration. The worker persists notification delivery attempts in its outbox and retries failures with backoff:

```sh
node packages/orchestrator/src/cli.mjs worker \
  --project ./project.json --interval-ms 30000 --auto-retry true
```

The worker selects active execution states. `RC_READY`, `RELEASE_APPROVED`, and `RELEASE_TRIGGERED` are advanced only when `runtime.release.autoAfterGate` is enabled; otherwise release remains a CLI action. `RELEASED` and `BLOCKED_USER_DECISION` are terminal. Stop it with `Ctrl+C`; it does not alter LingXi sessions, manual terminals, or existing AI bindings.

## Release approval record

After `rc-evaluate` has reached `RC_READY`, record an explicit human approval before any future release workflow can be dispatched:

```sh
node packages/orchestrator/src/cli.mjs release-approve \
  --id RND-001 --approved-by your-name --note "RC verified on Windows"
```

This only records authorization; it does not create a tag, GitHub Release, or deployment.

## Formal release trigger

After an explicit approval, the orchestrator can create only a stable, unit-specific tag at the verified delivery SHA: `x.y.z` for `obsidian-plugin` and `remote-x.y.z` for `remote`. It checks that the tag does not already exist, keeps a release lease while the protected GitHub workflow runs, and does not mark the task released until the named workflow succeeds.

```sh
node packages/orchestrator/src/cli.mjs release-trigger \
  --id RND-001 --project ./project.json --unit obsidian-plugin --tag 5.1.0
node packages/orchestrator/src/cli.mjs release-wait \
  --id RND-001 --unit obsidian-plugin --required "Obsidian Plugin Release"
```

These commands intentionally do not bypass GitHub Environment protection. A tag failure or a failed/timeout formal workflow moves the task to `BLOCKED_USER_DECISION` rather than attempting another tag.


## Codex native-session recovery

For controller-local Codex, add `--json` to the configured exec arguments so the runner can persist the native session ID from JSONL session-start events. Set `resumeNativeSession: true` and provide `resumeArgs` with a literal `{sessionId}` slot to opt into native resume on a subsequent attempt. The session ID is checkpoint metadata in SQLite; the approved task prompt and task events remain the fallback recovery package. Do not combine native resume with `--ephemeral`. CLI argument syntax is deliberately project-configured. Verify the resume invocation against the installed Codex version before enabling it; preflight currently checks the executable/version and authentication, but does not execute a resume command. Remote agents do not currently stream native-session events to the controller.


The optional `runtime.sandbox.enabled` flag currently fails closed with `PROJECT_RUNTIME_SANDBOX_NOT_IMPLEMENTED`; the orchestrator does not yet create or destroy an enforcing sandbox. Do not set it to true until a sandbox provider and B-side isolation verification are implemented.
