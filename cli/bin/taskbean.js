#!/usr/bin/env node
// Suppress node:sqlite experimental warning from polluting JSON output
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

import { program } from 'commander';
import { VERSION } from '../src/version.js';
import { checkForUpdates, maybePrintUpgradeNotice } from '../src/lib/update-notifier.js';
import { maybePrintSkillDriftNotice } from '../src/lib/skill-drift-notifier.js';

// Load command modules after installing the warning handler above. Several
// commands import node:sqlite through the shared store, and static ESM imports
// would emit the ExperimentalWarning before this file's body runs.
const { addCommand } = await import('../src/commands/add.js');
const { doneCommand } = await import('../src/commands/done.js');
const { listCommand } = await import('../src/commands/list.js');
const { editCommand } = await import('../src/commands/edit.js');
const { removeCommand } = await import('../src/commands/remove.js');
const { startCommand } = await import('../src/commands/start.js');
const { blockCommand } = await import('../src/commands/block.js');
const { remindCommand } = await import('../src/commands/remind.js');
const { reportCommand } = await import('../src/commands/report.js');
const { chronicleDoctorCommand, chronicleReconcileCommand } = await import('../src/commands/chronicle.js');
const { trackCommand, untrackCommand } = await import('../src/commands/track.js');
const { installCommand } = await import('../src/commands/install.js');
const {
  projectsCommand, hideCommand, showCommand, categorizeCommand, deleteCommand,
} = await import('../src/commands/projects.js');
const { serveCommand } = await import('../src/commands/serve.js');
const { packageCommand } = await import('../src/commands/package.js');
const { upgradeCommand } = await import('../src/commands/upgrade.js');
const { uninstallCommand } = await import('../src/commands/uninstall.js');
const { updateSkillCommand } = await import('../src/commands/update-skill.js');

// Fire-and-forget update check. Internally throttled to once per 24h, silent
// in CI / non-TTY / when TASKBEAN_NO_UPGRADE_NOTICE=1.
checkForUpdates();
process.on('exit', maybePrintUpgradeNotice);
process.on('exit', maybePrintSkillDriftNotice);

program
  .name('bean')
  .description('🫘 Task management CLI for AI coding agents')
  .version(VERSION)
  .enablePositionalOptions();

// === Agent Contract (3 commands) ===

program
  .command('add')
  .description('Log a task')
  .argument('<title>', 'Task title/description')
  .option('--key <key>', 'Stable key for upsert (prevents duplicates)')
  .option('--agent <name>', 'Coding agent: copilot | claude-code | codex | opencode')
  .option('--session-id <id>', 'Native session id for the chosen agent')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(addCommand);

program
  .command('done')
  .description('Mark a task as complete')
  .argument('<id>', 'Task ID or position number')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(doneCommand);

program
  .command('list')
  .alias('ls')
  .description('List tasks')
  .option('--status <status>', 'Filter by status (pending, in_progress, done, blocked)')
  .option('--all', 'Show tasks across all projects')
  .option('--count', 'Show counts instead of task list')
  .option('--by-project', 'Group by project (use with --all)')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(listCommand);

program
  .command('edit')
  .description('Edit a task')
  .argument('<id>', 'Task ID or position number')
  .option('--title <title>', 'New title')
  .option('--priority <level>', 'Priority: high, medium, low, none')
  .option('--notes <text>', 'Notes (markdown)')
  .option('--due-date <date>', 'Due date (YYYY-MM-DD or "clear")')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(editCommand);

program
  .command('remove')
  .alias('rm')
  .description('Delete a task')
  .argument('<id>', 'Task ID or position number')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(removeCommand);

program
  .command('start')
  .description('Mark a task as in-progress')
  .argument('<id>', 'Task ID or position number')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(startCommand);

program
  .command('block')
  .description('Mark a task as blocked')
  .argument('<id>', 'Task ID or position number')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(blockCommand);

program
  .command('remind')
  .description('Create a task with a reminder')
  .argument('<title>', 'Reminder text')
  .argument('<when>', 'When to remind (e.g. "tomorrow", "friday 9am", "in 2 hours")')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(remindCommand);

// === Human Contract (2 commands) ===

program
  .command('report')
  .description('Generate a report')
  .option('--date <range>', 'Date range: today, yesterday, week, all', 'today')
  .option('--format <fmt>', 'Output format: md, json, csv', 'md')
  .option('--json', 'Shorthand for --format json')
  .option('--project <path>', 'Filter to specific project')
  .action(reportCommand);

const chronicle = program
  .command('chronicle')
  .description('Inspect and reconcile Chronicle/session evidence');

chronicle
  .command('doctor')
  .description('Diagnose local Chronicle/session data availability')
  .option('--json', 'Output as JSON')
  .action(chronicleDoctorCommand);

chronicle
  .command('reconcile')
  .description('Create review-only suggestions from local Chronicle/session evidence')
  .option('--since <date>', 'Start date, YYYY-MM-DD (default: 7 days ago)')
  .option('--until <date>', 'End date, YYYY-MM-DD (default: today)')
  .option('--json', 'Output as JSON')
  .action(chronicleReconcileCommand);

program
  .command('track')
  .description('Set up a project for tracking')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--global', 'Install agent skill globally (~/.agents/skills/)')
  .option('--name <name>', 'Project display name')
  .option('--json', 'Output as JSON')
  .action(trackCommand);

program
  .command('install')
  .description('Install agent skill into a project')
  .option('--global', 'Install globally (~/)')
  .option('--agent <agent>', 'Target agent: copilot, claude, codex, opencode, all')
  .option('--force', 'Overwrite existing SKILL.md (upgrade)')
  .option('--codex-sandbox', 'Also configure ~/.codex/config.toml to allow Codex to write to ~/.taskbean (use with --agent codex or --agent all)')
  .option('--json', 'Output as JSON')
  .action(installCommand);

program
  .command('untrack')
  .description('Stop tracking a project')
  .option('--path <path>', 'Project path (default: cwd)')
  .option('--json', 'Output as JSON')
  .action(untrackCommand);

const projects = program
  .command('projects')
  .description('List and manage tracked projects')
  .passThroughOptions()
  .option('--json', 'Output as JSON')
  .option('--all', 'Include hidden projects')
  .option('--hidden', 'Show only hidden projects')
  .option('--category <label>', 'Filter by category')
  .action(projectsCommand);

projects
  .command('hide')
  .description('Hide a project from default views')
  .argument('[name]', 'Project name (default: current project)')
  .option('--json', 'Output as JSON')
  .action(hideCommand);

projects
  .command('show')
  .description('Show a hidden project')
  .argument('[name]', 'Project name (default: current project)')
  .option('--json', 'Output as JSON')
  .action(showCommand);

projects
  .command('categorize')
  .description('Set a category label on a project')
  .argument('[name]', 'Project name (default: current project)')
  .option('--category <label>', 'Category label (e.g. work, personal, oss)')
  .option('--clear', 'Remove the category')
  .option('--json', 'Output as JSON')
  .action(categorizeCommand);

projects
  .command('delete')
  .description('Delete a project and clean up its artifacts')
  .argument('[name]', 'Project name (default: current project)')
  .option('--confirm', 'Required to actually delete')
  .option('--keep-files', 'Skip filesystem cleanup')
  .option('--json', 'Output as JSON')
  .action(deleteCommand);

program
  .command('package')
  .description('Generate exportable work packages with session context')
  .argument('[id]', 'Task ID (optional — omit for batch mode)')
  .option('--date <range>', 'Date range: today, yesterday, week, all', 'today')
  .option('--format <fmt>', 'Output format: md, json', 'md')
  .option('--json', 'Shorthand for --format json')
  .option('--project <path>', 'Filter to specific project')
  .action(packageCommand);

program
  .command('serve')
  .description('Start the taskbean PWA server')
  .option('--port <port>', 'Port to listen on', '3000')
  .action(serveCommand);

program
  .command('upgrade')
  .description('Upgrade taskbean to the latest release')
  .option('--check', 'Report status only, do not install')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--dry-run', 'Print the planned action and exit without changes')
  .option('--json', 'Output as JSON')
  .option('--force', 'Re-download even if already up to date')
  .action(upgradeCommand);

program
  .command('uninstall')
  .description('Remove taskbean artifacts from this system')
  .option('--keep-data', 'Keep ~/.taskbean/ (preserves your task database)')
  .option('--scan [dir]', 'Scan filesystem for manually installed skill files')
  .option('--dry-run', 'Print what would be removed without doing it')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--force', 'Skip confirmation (alias for --yes)')
  .option('--json', 'Machine-readable output')
  .action(uninstallCommand);

program
  .command('update-skill')
  .description('Detect and refresh stale on-disk taskbean SKILL.md copies')
  .option('--apply', 'Rewrite stale copies in place (default: report only)')
  .option('--project', 'Only scan project-scoped skill dirs (cwd)')
  .option('--global', 'Only scan global/user-scoped skill dirs (~)')
  .option('--json', 'Machine-readable output')
  .action(updateSkillCommand);

program.parse();
