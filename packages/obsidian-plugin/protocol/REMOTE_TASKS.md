# Task stream extension v1

ALPN remains `termy/terminal/1`. Kind `0x20` uses the existing
`kind + unsigned LEB128 length + JSON UTF-8` framing and 1 MiB frame limit.
Each bidirectional stream carries one request and zero or more output events,
followed by exactly one result. The controller must keep its send half open
until the result; EOF/reset while executing cancels the process with an unknown outcome.

Request fields: `action`, `requestId`, `deviceId`; bound requests additionally
require `sessionId` and `bindingVersion`. All output/result events echo those
identifiers, plus `agentFingerprint` (the authenticated Iroh endpoint public key).
The receiver rejects mismatches. Bindings are scoped to the authenticated
controller connection; a new connection cannot reuse old session ids.

Actions:

- `bind`: `workDir` and absolute `shell`; returns `binding` with generated
  `sessionId`, `bindingVersion`, canonical `workDir`, and `shell`.
- `fs.read`, `fs.list`, `fs.delete`: relative `path`.
- `fs.write`: relative `path`, UTF-8 `content`.
- `command.run`: `command`, optional integer `timeoutMs` in 1..3600000.
- `command.cancel`: sent on the running command's stream with its `requestId`.

Output event: `event: "output"`, `channel: "stdout" | "stderr"`, `data` as
base64 bytes. The controller uses incremental UTF-8 decoding across chunks.
Result event: `event: "result"`, `status`, optional `result`, `error`, `exitCode`.
Command statuses: SUCCESS, FAILED, CANCELLED, UNKNOWN, TIMED_OUT, OUTPUT_LIMIT.
File success data lives in `result`; bind success data lives in `binding`.

Within a connection duplicate request ids are rejected without replay. B's
SQLite ledger provides persistent request deduplication across MCP restarts.
Old Agents reject kind 0x20; clients fail explicitly and never fall back to
terminal command injection or local file/command execution.

The existing binary codec is shared by the plugin and `packages/remote-sdk`
through the SDK build; Rust mirrors the same frame. Wire compatibility is
tested by the Node-to-Rust two-Agent integration test.
