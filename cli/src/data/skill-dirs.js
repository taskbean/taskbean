// Shared constants for skill directory paths across all agent platforms.
//
// Used by install, uninstall, untrack, and projects delete to stay in sync
// about where taskbean SKILL.md files can live.
import { join } from 'path';

// Per-project skill subdirectories (relative to project root).
// These cover all major coding agents that support the SKILL.md spec:
//   .agents/   — Copilot CLI, Codex, OpenCode, Amp (standard)
//   .github/   — GitHub Copilot cloud agent
//   .claude/   — Claude Code
//   .cursor/   — Cursor
//   .windsurf/ — Windsurf (Codeium)
//   .cline/    — Cline, Roo Code
export const PROJECT_SKILL_DIRS = [
  join('.agents', 'skills', 'taskbean'),
  join('.github', 'skills', 'taskbean'),
  join('.claude', 'skills', 'taskbean'),
  join('.cursor', 'skills', 'taskbean'),
  join('.windsurf', 'skills', 'taskbean'),
  join('.cline', 'skills', 'taskbean'),
];

// Global/user-level skill directories (relative to homedir).
export const GLOBAL_SKILL_DIRS = [
  join('.agents', 'skills', 'taskbean'),
  join('.github', 'skills', 'taskbean'),
  join('.claude', 'skills', 'taskbean'),
  join('.cline', 'skills', 'taskbean'),
  join('.codeium', 'windsurf', 'skills', 'taskbean'),
  join('.config', 'agents', 'skills', 'taskbean'),
];
