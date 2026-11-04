/**
 * Single registry for all coding-agent adapters.
 *
 * Structure:
 *  - AGENT_REGISTRY: tracked agents (usage scanning + skill install)
 *  - install-only agents: cursor, windsurf, cline (skill install only, no usage scanner)
 *
 * Adding a new tracked agent:
 *   1. Add one entry to AGENT_REGISTRY below.
 *   2. Add the corresponding scanner class to app/agent/usage/agents.py.
 *   Done — attribution, install, report, and skill-dir cleanup all derive from the registry.
 *
 * Adding an install-only agent:
 *   1. Add one entry to the INSTALL_ONLY_AGENTS array below.
 *   Done — cleanup commands (untrack, delete) pick it up automatically.
 */
import { join } from 'path';

/**
 * @typedef {Object} AgentEnvDetect
 * @property {string} var   Environment variable name.
 * @property {string} [eq]  If present, the variable must equal this exact value.
 *                           If absent, any truthy value matches.
 */

/**
 * @typedef {Object} AgentEntry
 * @property {string}           id               Canonical id used in DB, attribution, and reports.
 * @property {string}           displayName      Human-readable name for reports and the dashboard.
 * @property {string}           cliName          Binary name probed on PATH for `--agent auto`.
 * @property {AgentEnvDetect[]} envDetect        Any matching condition means "this agent is running".
 * @property {string[]}         envSessionId     Env vars to extract nativeId from (first truthy wins).
 * @property {string[]}         projectSkillDirs Skill dir paths relative to project root.
 * @property {string[]}         globalSkillDirs  Skill dir paths relative to homedir.
 * @property {boolean}          sandboxConfig    True if the agent needs a sandbox config mutation.
 */

export const AGENT_REGISTRY = /** @type {AgentEntry[]} */ ([
  {
    id: 'copilot',
    displayName: 'Copilot',
    cliName: 'copilot',
    envDetect: [
      { var: 'COPILOT_CLI_SESSION_ID' },
      { var: 'COPILOT_SESSION_ID' },
    ],
    envSessionId: ['COPILOT_CLI_SESSION_ID', 'COPILOT_SESSION_ID'],
    projectSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
      join('.github', 'skills', 'taskbean'),
    ],
    globalSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
      join('.github', 'skills', 'taskbean'),
    ],
    sandboxConfig: false,
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    cliName: 'claude',  // binary is named 'claude', not 'claude-code'
    envDetect: [
      { var: 'CLAUDECODE', eq: '1' },  // exact equality guard (Claude sets this to '1')
      { var: 'CLAUDE_CODE' },
      { var: 'ANTHROPIC_CLI' },
    ],
    envSessionId: ['CLAUDE_SESSION_ID'],
    projectSkillDirs: [
      join('.claude', 'skills', 'taskbean'),
    ],
    globalSkillDirs: [
      join('.claude', 'skills', 'taskbean'),
    ],
    sandboxConfig: false,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    cliName: 'codex',
    envDetect: [
      { var: 'CODEX_SESSION_ID' },
      { var: 'CODEX_HOME' },
    ],
    envSessionId: ['CODEX_SESSION_ID'],
    projectSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
    ],
    globalSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
    ],
    sandboxConfig: true,  // requires ~/.codex/config.toml mutation
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    cliName: 'opencode',
    envDetect: [
      { var: 'OPENCODE_SESSION' },
      { var: 'OPENCODE_SESSION_ID' },
    ],
    envSessionId: ['OPENCODE_SESSION', 'OPENCODE_SESSION_ID'],
    projectSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
    ],
    globalSkillDirs: [
      join('.agents', 'skills', 'taskbean'),
    ],
    sandboxConfig: false,
  },
]);

/**
 * Install-only agents: skill files can be installed for these agents but they
 * have no usage scanner.  They appear in allProjectSkillDirs() / allGlobalSkillDirs()
 * for cleanup (untrack, delete) but are NOT included in `--agent all` installs.
 */
const INSTALL_ONLY_AGENTS = [
  {
    id: 'cursor',
    projectSkillDirs: [join('.cursor', 'skills', 'taskbean')],
    globalSkillDirs: [],
  },
  {
    id: 'windsurf',
    projectSkillDirs: [join('.windsurf', 'skills', 'taskbean')],
    globalSkillDirs: [join('.codeium', 'windsurf', 'skills', 'taskbean')],
  },
  {
    id: 'cline',
    projectSkillDirs: [join('.cline', 'skills', 'taskbean')],
    globalSkillDirs: [join('.cline', 'skills', 'taskbean')],
  },
];

/** Canonical ids for the four tracked agents, in display order. */
export const AGENTS = AGENT_REGISTRY.map((a) => a.id);

/**
 * Look up a tracked agent by canonical id ('claude-code') or CLI binary name ('claude').
 * Returns null if not found.
 */
export function getAgent(idOrCli) {
  return AGENT_REGISTRY.find((a) => a.id === idOrCli || a.cliName === idOrCli) || null;
}

/**
 * Union of all per-project skill dirs across tracked + install-only agents.
 * Used by cleanup commands (untrack, projects delete) to find every possible SKILL.md.
 */
export function allProjectSkillDirs() {
  return [...new Set([...AGENT_REGISTRY, ...INSTALL_ONLY_AGENTS].flatMap((a) => a.projectSkillDirs))];
}

/**
 * Union of all global/user-level skill dirs across tracked + install-only agents.
 * Also includes the generic `.config/agents` path used by newer agent runtimes.
 */
export function allGlobalSkillDirs() {
  const dirs = [...AGENT_REGISTRY, ...INSTALL_ONLY_AGENTS].flatMap((a) => a.globalSkillDirs);
  dirs.push(join('.config', 'agents', 'skills', 'taskbean'));
  return [...new Set(dirs)];
}
