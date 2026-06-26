## Problem Statement

Taskbean users rely on the explicit local task ledger for weekly reports, one-on-ones, and performance-review evidence. That ledger is trustworthy when agents consistently call `bean add` before work and `bean done` after work, but it misses work when agents forget, when a session spans multiple repositories or branches, or when the user needs evidence beyond a task title.

Copilot Chronicle/session data can show what happened in local Copilot sessions: sessions, branches, modified files, PR and issue references, summaries, tools, and friction signals. Today Taskbean can diagnose whether local Chronicle/session data is available, but it does not yet use that evidence to help users reconcile missing work, enrich completed tasks, or build a weekly review.

The user needs a local-first review flow that preserves Taskbean as the canonical source of reportable tasks while using Chronicle/session data as supporting evidence and a source of review-only suggestions. Taskbean must not silently create retroactive completed tasks from session history, and it must not retain raw prompts or Copilot responses by default.

## Solution

Taskbean will add a Chronicle-backed weekly review and reconciliation workflow. The workflow will compare canonical Taskbean tasks with local Chronicle/session evidence, create a review inbox for likely untracked work, allow the user to approve, edit, link, or ignore suggestions, and generate weekly reports that clearly separate completed Taskbean tasks from Chronicle-derived suggestions.

The feature will build on the existing `bean chronicle doctor --json` capability check. It will add a read-only local session adapter, Taskbean-owned evidence and reconciliation records, CLI commands for reconcile/review decisions, report integration, app/API support, and dashboard surfaces for reviewing suggestions and evidence.

The product principle is: Taskbean owns outcomes; Chronicle owns evidence. A Taskbean task remains the durable reportable work item. Chronicle/session data becomes provenance, confidence, and coaching context. Reconciliation suggestions are proposals until the user explicitly accepts or links them.

## User Stories

1. As a Taskbean user, I want to run a weekly review that starts from my canonical Taskbean tasks, so that my report remains based on intentional work items.
2. As a Taskbean user, I want Taskbean to find likely untracked Copilot sessions from the week, so that missed work does not disappear from my review.
3. As a Taskbean user, I want untracked work to appear as review suggestions rather than completed tasks, so that I stay in control of my ledger.
4. As a Taskbean user, I want each suggestion to include a concise evidence summary, so that I can decide whether it represents real reportable work.
5. As a Taskbean user, I want each suggestion to show a confidence score, so that I can triage high-confidence and low-confidence items differently.
6. As a Taskbean user, I want to approve a suggestion into a new task, so that forgotten work can become part of my Taskbean ledger after review.
7. As a Taskbean user, I want to edit a suggestion before approval, so that the resulting task title, project, tags, priority, and status are report-ready.
8. As a Taskbean user, I want to link a suggestion to an existing task, so that session evidence enriches work I already logged.
9. As a Taskbean user, I want to ignore a suggestion, so that noise does not keep appearing in my review inbox.
10. As a Taskbean user, I want ignored suggestions to stay auditable, so that I can revisit a decision without re-importing raw session data.
11. As a Taskbean user, I want a completed task to show linked session evidence, so that I can explain what happened without searching Chronicle manually.
12. As a Taskbean user, I want weekly Markdown reports to include evidence footnotes for completed tasks, so that reports are more credible and easier to verify.
13. As a Taskbean user, I want JSON reports to expose tasks, evidence, suggestions, and confidence fields deterministically, so that agents and automations can consume them.
14. As a Taskbean user, I want reports to work when Chronicle data is unavailable, so that the core Taskbean weekly report is never blocked by Copilot installation, sync, or policy state.
15. As a Taskbean user, I want unavailable Chronicle evidence to be called out plainly, so that I know whether the report is canonical-only or evidence-enriched.
16. As a Taskbean user, I want Taskbean to avoid storing raw prompts, Copilot responses, code blocks, and tool outputs by default, so that reconciliation stays privacy-safe.
17. As a Taskbean user, I want an explicit richer-evidence option if raw or near-raw context is ever stored, so that privacy-sensitive behavior is opt-in.
18. As a Taskbean user, I want Taskbean to match sessions to tasks using timestamps, project path, branch, PRs, issues, files, and task/session attribution, so that suggestions are useful without pretending to be certain.
19. As a Taskbean user, I want ambiguous matches to remain pending, so that Taskbean never guesses by silently picking the most recent task.
20. As a CLI user, I want `bean chronicle reconcile` to create suggestions without mutating `todos`, so that I can safely run it daily or weekly.
21. As a CLI user, I want commands to list, approve, link, and ignore suggestions, so that reconciliation can be driven by agents and terminal workflows.
22. As a dashboard user, I want a reconciliation inbox with approve, edit, link, and ignore actions, so that I can review missed work visually.
23. As a dashboard user, I want evidence cards on task details, so that I can see the sessions, branches, PRs, issues, and file summaries behind a task.
24. As a dashboard user, I want a weekly report builder with toggles for canonical tasks, linked evidence, untracked-session appendix, and improvement suggestions, so that I can tailor the report to the audience.
25. As a dashboard user, I want to copy the generated weekly report as Markdown, so that I can paste it into status updates, one-on-ones, or performance docs.
26. As an agent, I want stable JSON contracts for reconcile, suggestions, decisions, and reports, so that I can automate review workflows without scraping text output.
27. As an agent, I want idempotent reconciliation for the same time window, so that retries do not duplicate suggestions.
28. As an agent, I want clear decision states for suggestions, so that I do not re-present approved, linked, or ignored work as pending.
29. As a project maintainer, I want Chronicle integration to stay local-first, so that Taskbean does not depend on unsupported remote Chronicle APIs.
30. As a project maintainer, I want the local adapter to tolerate missing or changing session-store schemas, so that Taskbean degrades gracefully as Copilot evolves.
31. As a project maintainer, I want privacy and sync limitations documented, so that users understand local session data, cloud sync policy, and opt-out behavior.
32. As a project maintainer, I want tests at the CLI contract and API/UI boundaries, so that implementation details can change without breaking user workflows.

## Implementation Decisions

- Taskbean remains the system of record for reportable tasks. Chronicle/session data is evidence and suggestion input only.
- The existing Chronicle doctor capability is the foundation. Reconciliation must first check local capability and report unavailable evidence without failing canonical reports.
- Reconciliation is local-first. The initial implementation should read local session metadata and structured local session-store data where available. It should not require a stable remote Chronicle API or non-interactive slash-command API.
- Raw prompts, Copilot responses, code blocks, and tool outputs are not stored in Taskbean by default. Persist summaries, pointers, references, timestamps, paths, branches, file lists, and confidence data instead.
- Add Taskbean-owned persistence for evidence linked to tasks and reconciliation suggestions. Evidence records should represent provenance for a task. Suggestion records should represent pending or decided proposals discovered from Chronicle/session history.
- Suggested decision states are `pending`, `approved`, `linked`, and `ignored`. The state model must make retries idempotent and prevent decided suggestions from returning to the active inbox.
- Reconciliation should be read-only with respect to `todos`. Creating or changing tasks happens only through explicit approval or linking commands/actions.
- Matching should combine project path, repository, branch, PR references, issue references, modified files, task attribution fields, timestamps, and existing session metadata. Low-confidence or ambiguous matches should remain review-only.
- CLI commands should expose the full workflow: diagnose, reconcile, list suggestions, approve, link, ignore, and report with Chronicle evidence.
- Report output should distinguish canonical completed, in-progress, and blocked tasks from Chronicle-derived pending suggestions. Markdown should be human-readable; JSON should be deterministic for agents and the dashboard.
- The app API should expose suggestions, decision actions, evidence detail, and report-preview data without requiring the frontend to query SQLite directly.
- The dashboard should treat Chronicle evidence as secondary to task status. The reconciliation inbox and task evidence cards should support the current local-first Taskbean identity and interaction model.
- Existing multi-agent usage tracking is related but separate. Agent usage tables provide session and token usage metadata; Chronicle evidence and reconciliation records should not be conflated with aggregate usage reporting.
- Documentation should cover privacy defaults, local file requirements, cloud sync uncertainty, Business/Enterprise policy limitations, and opt-out expectations.

## Testing Decisions

- Prefer the highest practical seams that exercise user-visible behavior: CLI command integration tests for reconciliation and report contracts, FastAPI integration tests for app APIs, and Playwright tests for the dashboard review flow.
- CLI tests should follow the existing integration-style command test pattern with temporary SQLite databases and fixture Copilot session data.
- The primary CLI seam should verify that `bean chronicle reconcile` creates deterministic review-only suggestions, never mutates `todos`, and is idempotent for the same evidence window.
- CLI decision tests should verify approve, edit-and-approve, link, and ignore behavior through public commands and JSON output rather than internal helper functions.
- Report tests should verify canonical-only reports still work when Chronicle data is unavailable and evidence-enriched reports clearly separate tasks from suggestions.
- Privacy tests should include sentinel raw prompt/response values in fixture session data and assert they never appear in Taskbean persistence or JSON output by default.
- FastAPI tests should verify suggestion listing, decision actions, task evidence detail, and report-preview responses against the shared SQLite database.
- Dashboard tests should cover the reconciliation inbox at the user-action level: review a pending suggestion, approve one, link one, ignore one, and copy or generate a weekly report preview.
- Unit tests may be added for confidence scoring only where pure scoring rules would otherwise be hard to exercise through the CLI seam, but external behavior tests should remain the primary protection.

## Out of Scope

- Replacing Taskbean's explicit task ledger with Chronicle/session data.
- Automatically creating completed tasks from Chronicle/session data without user approval.
- Storing raw prompts, Copilot responses, code blocks, or tool outputs by default.
- Depending on a stable remote Chronicle API before one is verified.
- Requiring Copilot cloud sync to be enabled.
- Backfilling all historical Copilot sessions into Taskbean automatically.
- Building a generalized session browser for all Chronicle content.
- Changing the existing multi-agent usage tracking policy or importing OpenCode costs.
- Implementing organization-wide reporting, team dashboards, or shared evidence review.

## Further Notes

Phase 1 is already complete in Taskbean v0.6.0: `bean chronicle doctor --json` detects local session-state and session-store availability, reports schema metadata, handles malformed databases, and preserves the default privacy boundary.

The remaining work should start with a narrow persisted reconciliation inbox and public CLI JSON contracts, then layer report integration, app APIs, dashboard surfaces, and automation recipes on top. This keeps each step demoable while preserving the product distinction between canonical tasks and Chronicle-derived evidence.

The parent feature request is taskbean/taskbean issue #40, "Chronicle-backed weekly reviews and task reconciliation." That GitHub issue should remain open until reconciliation, reporting, dashboard, and automation work are delivered.
