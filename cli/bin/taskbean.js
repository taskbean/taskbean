#!/usr/bin/env node
// Suppress node:sqlite experimental warning from polluting JSON output
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

import { program } from 'commander';
import { VERSION } from '../src/version.js';
import { checkForUpdates, maybePrintUpgradeNotice } from '../src/lib/update-notifier.js';
import { addCommand } from '../src/commands/add.js';
import { doneCommand } from '../src/commands/done.js';
import { listCommand } from '../src/commands/list.js';
import { reportCommand } from '../src/commands/report.js';
import { trackCommand, untrackCommand } from '../src/commands/track.js';
import { installCommand } from '../src/commands/install.js';
import { projectsCommand, hideCommand, showCommand, categorizeCommand, deleteCommand } from '../src/commands/projects.js';
import { serveCommand } from '../src/commands/serve.js';
import { packageCommand } from '../src/commands/package.js';
import { upgradeCommand } from '../src/commands/upgrade.js';

// Fire-and-forget update check. Internally throttled to once per 24h, silent
// in CI / non-TTY / when TASKBEAN_NO_UPGRADE_NOTICE=1.
checkForUpdates();
process.on('exit', maybePrintUpgradeNotice);

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
  .option('--status <status>', 'Filter by status (pending, done)')
  .option('--all', 'Show tasks across all projects')
  .option('--count', 'Show counts instead of task list')
  .option('--by-project', 'Group by project (use with --all)')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path')
  .action(listCommand);

// === Human Contract (2 commands) ===

program
  .command('report')
  .description('Generate a report')
  .option('--date <range>', 'Date range: today, yesterday, week, all', 'today')
  .option('--format <fmt>', 'Output format: md, json, csv', 'md')
  .option('--project <path>', 'Filter to specific project')
  .action(reportCommand);

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
  .argument('[task-id]', 'Task ID (optional — omit for batch mode)')
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

program.parse();
