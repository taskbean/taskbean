Status: done

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Add the dashboard experience for Chronicle-backed reconciliation and weekly reviews. Users should be able to open a reconciliation inbox, inspect suggestion evidence, approve or edit suggestions, link them to existing tasks, ignore noise, view evidence cards on task detail, and generate a weekly report draft with evidence and needs-review toggles.

The slice is complete when a user can complete the core review flow visually without needing to run the CLI for each decision.

## Acceptance criteria

- [x] The dashboard shows a reconciliation inbox with pending suggestions, confidence, and concise evidence summaries.
- [x] The dashboard supports approve, edit-and-approve, link-to-existing-task, and ignore actions.
- [x] Decided suggestions leave the pending inbox without requiring a full page reload.
- [x] Task detail shows a source/evidence card when Chronicle/session evidence is linked.
- [x] The weekly report builder supports toggles for canonical tasks, linked evidence, and pending suggestion appendix.
- [x] The user can copy or export the generated Markdown report draft.
- [x] Empty, unavailable, loading, and error states are clear and privacy-safe.
- [x] Playwright tests cover the inbox review flow, evidence card visibility, report preview toggles, and Markdown copy/export behavior.

## Blocked by

- `.scratch/chronicle-weekly-reviews-reconciliation/issues/04-app-api-for-reconciliation-and-evidence.md`
