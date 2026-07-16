---
title: Codex Protocol Compatibility
status: active
created: 2026-05-09
---

# Codex Protocol Compatibility

## Problem

`aiur-claude` is the Claude CLI adapter used by Aiur's Claude backend. It should remain a thin Codex app-server compatibility shim so Aiur can switch between the official Codex app-server and Claude without forking large protocol logic.

Current drift points:

- OpenAI's current app-server docs show JSON-RPC-shaped messages with the `jsonrpc` header omitted on the wire.
- Aiur sends `clientInfo` during `initialize`, while `aiur-claude` records only `client`.
- The local smoke test expects older top-level `thread_id` and `turns` shapes.
- `.claude/settings.local.json` is tracked even though it is local tool configuration.
- Package repository metadata no longer matches the active fork.

## Scope

In scope:

- Make inbound protocol parsing accept both explicit JSON-RPC 2.0 messages and Codex-style messages without `jsonrpc`.
- Preserve current outbound response and notification shapes unless a test requires a compatibility correction.
- Accept `clientInfo` alongside `client` for initialization metadata.
- Fix the smoke test to match the server's nested response contracts.
- Remove tracked local Claude settings and ignore future local Claude state.
- Correct package repository metadata.

Out of scope:

- Implementing additional Codex app-server methods.
- Changing Aiur's Elixir Claude backend.
- Reworking WebSocket pairing or TLS behavior.

## Implementation Units

### U1: Protocol Input Compatibility

Files:

- `src/protocol.ts`
- `src/server.ts`
- `test-client.mjs`

Approach:

- Relax `parseLine` so a message with `method` is accepted when `jsonrpc` is missing or equals `"2.0"`.
- Keep rejecting non-method payloads and explicit non-2.0 protocol versions.
- Read initialization metadata from `clientInfo` first, then `client`.
- Update the smoke test to use nested response fields.

Verification:

- `pnpm run build`
- `node test-client.mjs`

### U2: Repo Metadata Hygiene

Files:

- `.gitignore`
- `.claude/settings.local.json`
- `package.json`

Approach:

- Stop tracking local Claude settings and ignore `.claude/settings.local.json`.
- Update repository metadata to the active GitHub repo.

Verification:

- `git status --short`
- `pnpm run build`

## Commit Plan

- `Accept Codex wire format`
- `Clean local metadata`

