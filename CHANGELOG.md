# Changelog

## 1.3.0 (unreleased)

- Opt-in native `AskUserQuestion` forwarding via `item/tool/requestUserInput`,
  with stable question IDs, deferred-session resume, release and interruption.
- Preserve aggregate token usage and exact decimal costs across native resumes.
- `turn/steer` queues non-empty text for the next turn on the thread instead of
  injecting it into the running turn.

These are release preparations; npm publication is a maintainer action after merge.
