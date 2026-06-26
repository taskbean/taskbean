Status: done

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Build the first end-to-end reconciliation slice: a user can run a Chronicle reconciliation command for a date window and receive deterministic, review-only suggestions backed by local session evidence. The command should use existing Chronicle/session capability detection, read only privacy-safe metadata, persist suggestion and evidence records owned by Taskbean, and leave canonical `todos` unchanged.

The slice is complete when a weekly or daily reconciliation can be run safely more than once and produces a pending inbox of likely untracked work with evidence summaries and confidence values.

## Acceptance criteria

- [x] A public CLI command reconciles a `since`/`until` window and returns deterministic JSON.
- [x] Reconciliation creates pending suggestion records without creating, completing, or editing `todos`.
- [x] Reconciliation records enough evidence to explain each suggestion: source sessions, project/repo path, branch, PR/issue references when available, changed-file summary when available, confidence, and concise evidence summary.
- [x] Running reconciliation repeatedly for the same source evidence is idempotent and does not duplicate pending suggestions.
- [x] Missing Chronicle/session data produces a clear unavailable result and does not fail canonical Taskbean behavior.
- [x] Fixture data containing raw prompt/response sentinel values does not leak into persisted Taskbean records or JSON output by default.
- [x] CLI tests cover missing data, valid local session metadata, malformed/partial schema behavior, idempotency, no todo mutation, and raw-content non-leakage.

## Blocked by

None - can start immediately
