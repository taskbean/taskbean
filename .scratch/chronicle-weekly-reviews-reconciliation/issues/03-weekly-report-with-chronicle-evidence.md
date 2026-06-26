Status: done

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Extend weekly reporting so users can generate canonical Taskbean reports with optional Chronicle/session evidence. The report should keep completed, in-progress, and blocked Taskbean tasks as the main report body, add concise evidence for linked tasks, and include pending reconciliation suggestions as a clearly marked review appendix.

The slice is complete when Markdown and JSON reports can be generated with or without Chronicle evidence and are safe to use for weekly reviews even when Chronicle data is unavailable.

## Acceptance criteria

- [x] Weekly report generation supports an explicit option to include Chronicle/session evidence.
- [x] Canonical Taskbean task counts and sections remain correct whether or not Chronicle evidence is available.
- [x] Linked evidence appears under the relevant task as concise provenance rather than raw session content.
- [x] Pending suggestions appear in a separate "needs review" or equivalent appendix and are not counted as completed tasks.
- [x] Markdown output is suitable for a weekly review document.
- [x] JSON output exposes period, canonical task groups, evidence, pending suggestions, confidence values, and Chronicle availability deterministically.
- [x] When Chronicle/session data is unavailable, the report states that evidence is unavailable and still completes successfully.
- [x] CLI tests cover canonical-only reports, evidence-enriched reports, unavailable evidence, pending suggestion appendix behavior, and JSON determinism.

## Blocked by

- `.scratch/chronicle-weekly-reviews-reconciliation/issues/01-reconcile-session-evidence-into-review-inbox.md`
- `.scratch/chronicle-weekly-reviews-reconciliation/issues/02-review-suggestion-decisions.md`
