---
artifact_shape: compact
generated: 2026-08-10
route: codebase-architecture
disclosure: repository
---

# Taskbean worktree parent model

Taskbean must separate a logical **Project** from a physical **Workspace**.

Use normalized Git repository identity, normally `owner/repo`, as the Project Key. Record each local main checkout and each isolated Copilot worktree as a child Workspace. Keep Copilot project and session IDs as provider aliases and attribution data, not as the canonical Taskbean project key.

This model gives one project entry in the dashboard and keeps branch, worktree, agent, and session data available for drill-down. It also works for Claude Code, Codex, OpenCode, and ordinary directories.

The repository already defines this target model in `CONTEXT.md` and ADRs 0001-0003. The current implementation has not completed the cutover. It still creates projects from physical paths, so each worktree can appear as a separate dashboard project.

## Recommended identity order

1. Resolve a normalized Git remote identity. Prefer an explicit canonical remote policy, such as `upstream` and then `origin`.
2. Match a stored provider alias, such as a Copilot project ID, when repository identity is absent.
3. Match an existing Workspace by canonical path.
4. Put ambiguous or unmatched work in **Unassigned Work**. Never merge unrelated clones without evidence.

## Confidence and gaps

**High** confidence for the Project and Workspace split. **Medium** confidence for all migration details.

Open decisions:

- Define whether a GitHub repository rename changes the Project Key or adds a durable alias.
- Define attribution for remote-only or cloud sessions that have no local `cwd`.
- Confirm the supported contract for Copilot app host metadata such as `project_id` and `main_repo_path`.

## Key sources

- `CONTEXT.md:5-53`
- `docs/adr/0001-owner-repo-project-key.md:3`
- `docs/adr/0002-first-class-workspaces.md:3`
- `docs/adr/0003-replace-legacy-project-fields.md:3`
- `cli/src/data/project.js:25-75`
- `cli/src/data/store.js:82-118`
- `app/agent/usage/db.py:329-343`
- `app/agent/usage/scanners/copilot.py:56-70,93-106`
- `cli/src/lib/attribution.js:19,43-61`
- GitHub Docs, "GitHub Copilot CLI Chronicle": https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- GitHub Docs, "Manage and track coding agents": https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents

## Critic

**PASS with caveats.** The evidence is sufficient for the parent model. Public evidence does not fully specify Copilot app internal project metadata, so provider IDs must remain optional aliases.

