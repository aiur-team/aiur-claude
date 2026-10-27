# Native question fixture

`native-deferred.ndjson` is copied byte-for-byte from
`docs/research/aiur-mobile-and-platform/bucket-2-platform/MP-E2/fixtures/isolated-defer-run1.ndjson`
at aiur-team/aiur commit `de341053cc16d2e6096a3a0d0fbacb43ef9f6eb0`.

Source: https://github.com/aiur-team/aiur/issues/4451

The accepted spike selected Variant A (PreToolUse defer and session resume),
using Claude Code 2.1.299. Its multi-call probes also honored deferral: consumers
must use terminal result metadata, rather than infer deferral from tool count.
This fixture retains the research pack's documented redactions unchanged.
