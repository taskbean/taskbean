Status: ready-for-agent

## Parent

`.scratch/chronicle-weekly-reviews-reconciliation/PRD.md`

GitHub parent: taskbean/taskbean#40

## What to build

Document and validate the user-facing automation and privacy guidance for Chronicle-backed weekly reviews. Users should know how to run daily reconciliation, weekly report drafting, and monthly improvement review while understanding local session data, cloud sync uncertainty, enterprise policy limitations, and Taskbean's default non-retention of raw prompts and responses.

The slice is complete when the feature is understandable, automatable, and safe to operate without relying on tribal knowledge.

## Acceptance criteria

- [ ] Documentation explains the daily reconciliation workflow and the expected pending-suggestion review step.
- [ ] Documentation explains the weekly review workflow, including canonical-only and evidence-enriched report modes.
- [ ] Documentation explains how pending suggestions differ from Taskbean tasks and why approval is required.
- [ ] Documentation explains privacy defaults, including no raw prompt/response storage by default.
- [ ] Documentation explains local Chronicle/session data availability, cloud sync uncertainty, Business/Enterprise policy limitations, and opt-out considerations.
- [ ] Automation examples use stable CLI JSON contracts rather than scraping Markdown output.
- [ ] Documentation states what happens when Chronicle/session data is unavailable.
- [ ] Existing package/skill documentation is updated so agents can discover the reconciliation workflow.

## Blocked by

- `.scratch/chronicle-weekly-reviews-reconciliation/issues/03-weekly-report-with-chronicle-evidence.md`
- `.scratch/chronicle-weekly-reviews-reconciliation/issues/05-dashboard-reconciliation-inbox-and-report-builder.md`
