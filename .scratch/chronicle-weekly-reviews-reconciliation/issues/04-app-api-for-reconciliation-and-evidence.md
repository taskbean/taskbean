Status: ready-for-agent

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Expose the reconciliation inbox, suggestion decision actions, task evidence, and report preview through the local app API. The API should use the same shared Taskbean database and contracts as the CLI so the dashboard can manage the same review workflow without direct database access.

The slice is complete when the app can list pending suggestions, decide them, show evidence for a task, and request a report preview through stable JSON endpoints.

## Acceptance criteria

- [ ] The app API can return reconciliation suggestions filtered by status.
- [ ] The app API can approve, link, and ignore suggestions using the same decision semantics as the CLI.
- [ ] The app API can return linked evidence as part of task detail data.
- [ ] The app API can return a weekly report preview with canonical tasks, linked evidence, pending suggestions, and Chronicle availability.
- [ ] API responses do not include raw prompt/response content by default.
- [ ] API errors for invalid suggestions, invalid task links, and repeated decisions are explicit and consistent.
- [ ] FastAPI integration tests cover suggestion listing, decision actions, task evidence detail, report preview, unavailable evidence, and privacy non-leakage.

## Blocked by

- `.scratch/chronicle-weekly-reviews-reconciliation/issues/01-reconcile-session-evidence-into-review-inbox.md`
- `.scratch/chronicle-weekly-reviews-reconciliation/issues/02-review-suggestion-decisions.md`
- `.scratch/chronicle-weekly-reviews-reconciliation/issues/03-weekly-report-with-chronicle-evidence.md`
