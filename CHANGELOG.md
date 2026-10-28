# Changelog

## 1.3.0

First npm release since 1.0.0. Versions 1.1.0 (git tag only) and 1.2.0 were
never published to npm, so their changes ship here.

- Opt-in native `AskUserQuestion` forwarding via `item/tool/requestUserInput`,
  with stable question IDs, deferred-session resume, release and interruption.
- Preserve aggregate token usage and exact decimal costs across native resumes.
- `turn/steer` queues non-empty text for the next turn on the thread instead of
  injecting it into the running turn (1.2.0).
- Forward CLI provider-error provenance on `turn/failed` (1.2.0).
- Read quota utilization from `/api/oauth/usage` (1.1.0).
- Forward sanitized `rate_limit/update` events; add `cost_usd_raw` with the
  exact decimal cost (1.1.0).
- Serve engine `dynamicTools` to Claude through an in-process MCP bridge (1.1.0).
- Rename the package and binary to `aiur-claude` (1.1.0).
