# Taskbean

Taskbean captures developer work and groups it so tasks, agent sessions, and review evidence can be reported at the right level.

## Language

**Project**:
A logical repo or product that work rolls up to for task lists, usage, reconciliation, and reports. A Project is not an individual checkout, worktree, fork, or agent session; Git-backed Projects display as `owner/repo` by default.
_Avoid_: Checkout, worktree, session, folder

**Project ID**:
The durable internal identity of a Project. It does not change when a repository is renamed or transferred.
_Avoid_: Project Key, repository name

**Project Key**:
The current canonical identity used to recognize a Project across multiple Workspaces. For Git-backed work, the Project Key is the nearest Git repository's owner and name, preferring `upstream` over `origin`; for work without a usable GitHub remote, it falls back to the canonical local path. When a repository is renamed or transferred, the Project keeps its Project ID, adopts the new Project Key, and retains the old key as a Project Alias.
_Avoid_: Path, checkout name, worktree name

**Project Alias**:
A former Project Key or provider identity that still resolves to the same Project. An alias helps Taskbean recognize repository renames, transfers, and provider records without making provider-specific values canonical.
_Avoid_: Project Key, display name

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

**Remote Workspace**:
A pathless Workspace where an Agent Session runs outside the local machine. Taskbean creates it only when repository metadata or a known Project Alias resolves one Project without ambiguity; otherwise the session remains Unassigned Work. A Remote Workspace and a local Workspace merge only when stable lineage evidence proves they are the same execution lineage.
_Avoid_: Project, local checkout, cloud project

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

**Execution Profile**:
The automatically discovered context Taskbean uses to prepare a Task for agent execution. It includes relevant Project instructions and available agent capabilities, with optional global, Project, or Task overrides.
_Avoid_: Agent config, skill dump, prompt template

**Kickoff Prompt**:
The environment-aware, optimized instruction Taskbean prepares for an Agent Session to execute a Task. A Kickoff Prompt can be revised, copied, or launched without changing the Task itself.
_Avoid_: Task description, chat message

**Execution Record**:
The link between a canonical Task and the Agent Session that executes it, including the Kickoff Prompt version, execution status, and review evidence.
_Avoid_: Task, session

**Execution Step**:
A session-scoped step in an agent's plan for completing a Task. Execution Steps can be added, removed, renamed, or reordered during execution and remain subordinate to the canonical Task.
_Avoid_: Task, subtask
