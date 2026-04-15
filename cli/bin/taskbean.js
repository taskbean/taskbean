#!/usr/bin/env node
import { program } from 'commander';
import { addCommand } from '../src/commands/add.js';
import { doneCommand } from '../src/commands/done.js';
import { listCommand } from '../src/commands/list.js';
import { reportCommand } from '../src/commands/report.js';
import { trackCommand } from '../src/commands/track.js';

program
  .name('bean')
  .description('🫘 Task management CLI for AI coding agents')
  .version('0.5.0');

// === Agent Contract (3 commands) ===

program
  .command('add')
  .description('Log a task')
  .argument('<title>', 'Task title/description')
  .option('--key <key>', 'Stable key for upsert (prevents duplicates)')
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

program.parse();
