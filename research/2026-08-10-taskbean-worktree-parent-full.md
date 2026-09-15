---
artifact_shape: full
generated: 2026-08-10
route: codebase-architecture
disclosure: repository
---

# Taskbean Project and Workspace model for Copilot worktrees

## Recommendation

Adopt a two-level model:

- **Project** is the durable human grouping for one logical repository or product.
- **Workspace** is one physical checkout or execution location under that Project.
- **Agent Session** remains the attribution unit under a Workspace.

Use normalized Git repository identity as the preferred Project Key. Store Copilot project IDs, session IDs, paths, branches, and other provider facts as aliases or child metadata. This gives the dashboard one parent project while it preserves all worktree and session evidence.

This is not a new architecture decision. Taskbean already records the domain vocabulary and target decisions in `CONTEXT.md` and ADRs 0001-0003. The required work is an implementation cutover from the legacy path-based model.

## Scope and method

The research used the codebase architecture route with an implementation-pattern comparison. It inspected Taskbean domain documents, schema and project resolution code, Copilot usage scanning, and multi-agent attribution. It also used current GitHub documentation for the Copilot local session-state and cloud-agent lifecycle.

The assessment is read-only. It does not implement or migrate the model.

## Observed Copilot model

The Copilot app manages a stable project and creates sessions against either a local checkout or an isolated worktree. The host context exposes a stable project ID, project repository, default branch, session ID, workspace path, workspace type, and current branch. Isolated worktrees use:

`~/.copilot/repos/copilot-worktrees/<repository>/<session-worktree>`

GitHub documents local Copilot CLI session state and its session store. GitHub also documents managed coding-agent sessions as separate, ephemeral execution contexts. Public documentation does not define the app's complete internal `project_id` and `main_repo_path` schema. These fields are useful provider evidence, but they are not safe as Taskbean's only canonical identity.

Sources:

- GitHub Docs, "GitHub Copilot CLI Chronicle": https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- GitHub Docs, "Manage and track coding agents": https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
- Current host project and workspace metadata supplied to this session.

## Observed Taskbean architecture

`CONTEXT.md:5-53` defines Project, Workspace, Agent Session, Copilot Fork, and Unassigned Work as separate concepts.

The repository decisions state:

- `docs/adr/0001-owner-repo-project-key.md:3` selects `owner/repo` as Project Key.
- `docs/adr/0002-first-class-workspaces.md:3` makes Workspace a first-class child of Project.
- `docs/adr/0003-replace-legacy-project-fields.md:3` selects a breaking cutover and an Unassigned Work fallback.

The implementation still uses the legacy model:

- `cli/src/data/project.js:25-75` resolves a project from the current directory and Git root. Each Git worktree has a distinct physical root, so separate worktrees can resolve to separate project rows.
- `cli/src/data/store.js:82-118` defines the current `projects` table around a unique physical path. It has no canonical repository identity that can group several paths.
- `app/agent/usage/db.py:329-343` resolves agent sessions to projects with a `cwd` path-prefix match.
- `app/agent/usage/scanners/copilot.py:56-70,93-106` already captures repository, current directory, and Git branch from Copilot sessions.
- `cli/src/lib/attribution.js:19,43-61` supports Copilot, Claude Code, Codex, and OpenCode. A Copilot-only canonical key would weaken this multi-agent design.

## Identity and data flow

Current flow:

```text
Task created in checkout
  -> resolve current directory or Git root
  -> find or create project by physical path
  -> show project row in dashboard filter
```

Recommended flow:

```text
Task or session evidence
  -> resolve repository identity and provider aliases
  -> find one logical Project
  -> find or create the physical Workspace
  -> attribute the Agent Session to the Workspace
  -> attach the task to Project, Workspace, and optional Agent Session
  -> show Project in the primary dashboard filter
  -> show Workspace, branch, and session as drill-down data
```

## Candidate evidence matrix

| Candidate | Supporting evidence | Adversarial evidence | Decision |
| --- | --- | --- | --- |
| A. Normalize only by Git repository identity | Groups all worktrees for the same remote. Agrees with ADR-0001. | Does not represent physical checkouts, folder projects, missing remotes, or provider-only sessions. Repo rename and fork policy need aliases. | Use for the preferred Project Key, but not as the complete model. |
| B. Use Copilot `project_id` as the parent | Stable inside the Copilot app and maps to the app's project UI. | Couples canonical data to one provider. Public docs do not define the full contract. Does not solve non-Copilot work. | Store as an alias, not the primary key. |
| C. Project with Workspace members and provider aliases | Groups worktrees and preserves checkout and session detail. Agrees with ADR-0002 and multi-agent support. | Needs schema migration, precedence rules, ambiguity handling, and UI changes. | **Recommended.** |
| D. Group only in the dashboard UI | Can remove visual clutter quickly. | Reports, APIs, attribution, and reconciliation still have duplicate identities. | Do not use as the final solution. |

## Recommended domain and data model

### Project

- `id`
- `project_key`
- `display_name`
- `kind`, such as `git-repository`, `folder`, or `unassigned`
- normalized repository owner and name when available
- lifecycle fields and timestamps

### Workspace

- `id`
- `project_id`
- canonical local path when available
- workspace kind, such as `main-checkout`, `worktree`, `folder`, or `remote`
- branch and head commit when available
- active or archived state
- created, last seen, and removed timestamps

### Provider alias

- provider, such as `copilot`, `claude-code`, `codex`, or `opencode`
- alias kind, such as `project-id`, `repository`, or `workspace-id`
- alias value
- optional Project or Workspace target
- first seen and last seen timestamps

### Task attribution

A task has:

- required `project_id`, including Unassigned Work
- optional `workspace_id`
- optional `agent_session_id`

This permits durable project reporting and precise execution evidence.

## Identity precedence and ambiguity rules

1. Use a normalized, approved Git remote identity. Prefer `upstream`, then `origin`, when both policies apply.
2. Use a verified provider project or repository alias if Git identity is unavailable.
3. Match an existing Workspace by canonical path.
4. Use a folder Project Key only for non-Git work.
5. Send conflicting or insufficient evidence to Unassigned Work.

Never merge only because two workspaces have the same directory name, branch name, or repository basename.

**Inference:** Provider aliases should corroborate identity, not override a conflicting Git remote. This follows from the requirement to avoid silent merges and from the lack of a public stable contract for Copilot internal IDs.

## Migration outline

1. Add Project, Workspace, and alias structures without changing reads.
2. Inventory current project rows and derive candidate repository identities from active paths and known session metadata.
3. Create one Project per unambiguous canonical repository identity.
4. Convert each existing physical project path into a Workspace.
5. Attach existing tasks to the new Project and Workspace when evidence is unambiguous.
6. Put ambiguous rows in a review queue or Unassigned Work. Do not auto-merge them.
7. Change all write paths to resolve Project first and Workspace second.
8. Change reports, APIs, and the dashboard to use Project as the primary grouping.
9. Remove legacy project fields only after parity checks pass, in line with ADR-0003.

## UI and API implications

- The dashboard Project filter lists logical Projects only.
- Each task card can show a compact Workspace or branch label.
- Project detail can list active main checkouts, worktrees, remote workspaces, and Agent Sessions.
- Reports aggregate by Project and permit optional Workspace and agent breakdowns.
- Reconciliation links evidence to the Agent Session and Workspace while it keeps canonical task status at Project level.
- APIs return stable Project IDs and linked Workspace data. Clients do not parse worktree paths.

## Risks and unknowns

- A GitHub repository rename can change an `owner/repo` key. The model needs a rename or alias rule.
- Forks can share code history but represent different ownership. Remote precedence must not merge them silently.
- Cloud sessions can lack a local path. Repository and provider metadata must be sufficient, or the session remains unassigned.
- Old paths can be stale or reused. Path is Workspace evidence, not durable Project identity.
- A provider can change its internal schema. Provider aliases must be optional and version-tolerant.

## Smallest validation spike

Build a read-only resolver prototype against a copy of the database and current session metadata:

1. Enumerate current project rows and detected workspaces.
2. Produce proposed Project Key, Workspace membership, evidence used, and confidence.
3. Flag every collision or ambiguous merge.
4. Compare the proposed dashboard Project list with the current flat list.
5. Require zero silent many-to-one merges before migration work starts.

This spike tests the highest-risk assumption: repository and provider evidence can group existing worktrees without merging unrelated work.

## Evidence-to-action trace

- Path uniqueness creates duplicate project rows across worktrees (`cli/src/data/project.js:25-75`; `cli/src/data/store.js:82-118`). Path must move to Workspace identity.
- Copilot scanning already captures repository and session facts (`app/agent/usage/scanners/copilot.py:56-70,93-106`). The resolver can use richer evidence.
- Multi-agent attribution already exists (`cli/src/lib/attribution.js:19,43-61`). Copilot IDs must be provider aliases instead of the universal key.
- Domain documents already select Project Key, Workspace, cutover, and Unassigned Work (`CONTEXT.md:5-53`; ADRs 0001-0003). Implementation must follow the decided split.

## Critic verdict

**PASS with caveats.**

The evidence answers the core architecture and pattern decision. Supporting and adversarial evidence is present for all four candidates. The recommendation follows from the code, domain decisions, and multi-agent constraint.

Public evidence does not fully define Copilot app internal project metadata. This does not block the decision because the recommendation keeps provider metadata optional. Repository rename and remote-only session rules remain explicit follow-up decisions.

