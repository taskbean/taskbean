# Taskbean

Taskbean captures developer work and groups it so tasks, agent sessions, and review evidence can be reported at the right level.

## Language

**Project**:
A logical repo or product that work rolls up to for task lists, usage, reconciliation, and reports. A Project is not an individual checkout, worktree, fork, or agent session; Git-backed Projects display as `owner/repo` by default.
_Avoid_: Checkout, worktree, session, folder

**Project Key**:
The stable identity used to recognize the same Project across multiple Workspaces. For Git-backed work, the canonical Project Key is the nearest Git repository's owner and name, preferring `upstream` over `origin`; for work without a usable GitHub remote, it falls back to the canonical local path.
_Avoid_: Path, checkout name, worktree name

**Project Selector**:
A user-provided value that identifies a Project by key or display name, or identifies a Workspace when it clearly looks like a path. A Workspace selector resolves to its owning Project.
_Avoid_: Workspace path, project path

**Workspace**:
A physical checkout, worktree, fork, or folder where work happens for a Project. Multiple Workspaces can belong to the same Project.
_Avoid_: Project, session

**Tracked Project**:
A Project that appears in default task, usage, reconciliation, and report rollups because at least one Workspace is tracked.
_Avoid_: Tracked folder

**Tracked Workspace**:
A Workspace that participates in physical-path behavior such as agent detection, skill installation, cleanup, and diagnostics.
_Avoid_: Tracked project

**Discovered Workspace**:
A Workspace observed from agent session metadata or task provenance but not explicitly tracked by the user. Discovered Workspaces can support attribution and rollups but are not mutated with skill files or cleanup actions.
_Avoid_: Tracked workspace

**Primary Workspace**:
The Workspace a Project uses by default for path-dependent actions such as opening folders, installing skills, or diagnostics. The Primary Workspace is user-changeable and should not be inferred solely from the most recent Agent Session.
_Avoid_: Latest workspace

**Agent Session**:
One run of a coding agent, scoped to a Workspace, that can create tasks, usage records, or Chronicle evidence. Agent Sessions roll up through their Workspace to a Project; session and fork lineage is provenance, not a Project boundary.
_Avoid_: Project, workspace

**Copilot Fork**:
A Copilot-created branch of an existing session or workspace lineage. A Copilot Fork belongs to the same Project as its source and must not create a separate Project.
_Avoid_: GitHub fork, project fork

**Task**:
A unit of developer work that can belong to a Project and can carry Workspace provenance when created from a physical workspace. Manual tasks created without project context may be Project-agnostic and Workspace-agnostic.
_Avoid_: Session, workspace

**Unassigned Work**:
Tasks, Agent Sessions, or evidence that Taskbean cannot confidently resolve to a Project. Unassigned Work appears for review instead of creating a fake Project from a session id, GUID, or folder basename.
_Avoid_: Misc project, unknown project, session project
