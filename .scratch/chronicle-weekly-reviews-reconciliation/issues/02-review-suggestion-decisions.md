Status: done

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Build the suggestion decision workflow so a user or agent can list pending Chronicle/session suggestions, approve a suggestion into a Taskbean task, link a suggestion to an existing task, or ignore a suggestion. The decision workflow must make explicit user approval the only path from Chronicle-derived evidence to canonical task changes.

The slice is complete when the review inbox is actionable from the CLI and decided suggestions stay out of the pending inbox while remaining auditable.

## Acceptance criteria

- [x] A public CLI command lists suggestions by status with deterministic JSON.
- [x] A public approval command creates a Taskbean task from a suggestion only after explicit approval.
- [x] Approval supports editing the report-facing task fields before creation where practical.
- [x] A public link command attaches suggestion evidence to an existing task without creating a duplicate task.
- [x] A public ignore command marks a suggestion ignored and removes it from the pending inbox.
- [x] Approved, linked, and ignored suggestions retain decision timestamps and enough metadata to audit the decision.
- [x] Invalid suggestion IDs, missing task IDs, and already-decided suggestions surface clear errors and do not silently no-op.
- [x] CLI tests cover list, approve, edit-and-approve, link, ignore, repeated decisions, invalid IDs, and evidence attachment.

## Blocked by

- `.scratch/chronicle-weekly-reviews-reconciliation/issues/01-reconcile-session-evidence-into-review-inbox.md`
