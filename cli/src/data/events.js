/**
 * Append-only event log — Phase 4 foundation.
 *
 * Each mutation (`bean add`, `bean done`, etc.) writes one JSON line to
 * `<repo>/.taskbean/events.jsonl`. The events file is the long-term canonical
 * source of truth (Phase 5 makes `tasks.db` a derived cache). For Phase 4,
 * the global DB stays authoritative — events are a *shadow* log we can use
 * to verify replay parity before flipping the source-of-truth bit.
 *
 * Design constraints (from research §12 in plan.md):
 *   • Text, line-oriented → git-mergeable when committed.
 *   • Append-only → no in-place edits, no partial-write torn states.
 *   • Best-effort → primary DB write already succeeded; report failures on
 *     stderr so callers know the event history may need review.
 *   • No project UUID → no events file. Untracked projects keep working
 *     exactly as today.
 *   • The project path is omitted from the project object. Legacy
 *     project.track events also contain cwdAtTrack; event logs remain local
 *     and gitignored by default.
 *
 * Format (v1):
 *   {
 *     "v":       1,
 *     "id":      "<event uuid>",
 *     "ts":      "<ISO 8601 UTC>",
 *     "type":    "task.add" | "task.complete" | "task.start" | "task.block"
 *              | "task.update" | "task.remove" | "task.remind"
 *              | "project.track",
 *     "actor":   { "agent": string|null, "sessionId": string|null,
 *                  "host": "windows"|"linux"|"macos"|"wsl"|null },
 *     "project": { "uuid": string, "name": string },   // path intentionally omitted
 *     "payload": <type-specific>
 *   }
 *
 * Schema evolution: bump SCHEMA_VERSION when payload semantics change.
 * Replay (`replayEvents`) refuses to process events with v > the version
 * it was compiled against — preventing a stale CLI from silently
 * mis-interpreting a newer event log written by an updated CLI.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { detectHost } from './host.js';

const SCHEMA_VERSION = 1;

/**
 * Append a single event to `<projectPath>/.taskbean/events.jsonl`.
 *
 * @param {object} ctx
 * @param {string} ctx.projectPath  Absolute path to the project root.
 * @param {string|null} ctx.projectUuid  Stable UUID; if null, no-op.
 * @param {string} ctx.projectName  Project display name.
 * @param {string} ctx.type  Event type (see file header).
 * @param {object} ctx.payload  Type-specific data.
 * @param {object} [ctx.actor]  Optional { agent, sessionId } overrides.
 * @returns {string|null}  The event id on success, null if skipped/failed.
 */
export function appendEvent(ctx) {
  return appendEvents(ctx, [ctx])?.[0] || null;
}

export function appendEvents(ctx, entries) {
  if (!ctx || !ctx.projectUuid || !ctx.projectPath || !entries.length) return null;
  const events = entries.map(entry => ({
    v: SCHEMA_VERSION,
    id: randomUUID(),
    ts: entry.ts || new Date().toISOString(),
    type: entry.type,
    actor: _normalizeActor(entry.actor),
    project: { uuid: ctx.projectUuid, name: ctx.projectName || '' },
    payload: entry.payload || {},
  }));
  const contents = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''));
  const tbDir = resolve(ctx.projectPath, '.taskbean');
  const filePath = resolve(tbDir, 'events.jsonl');

  try {
    if (!existsSync(tbDir)) {
      mkdirSync(tbDir, { recursive: true });
    }
    _ensureGitignore(tbDir);
    // O_APPEND guarantees atomic appends on POSIX; on Windows node still
    // serializes the write at the FS level for typical line sizes.
    const fd = openSync(filePath, 'a');
    try {
      if (writeSync(fd, contents) !== contents.length) {
        throw new Error('incomplete event write; inspect the history before replay');
      }
    } finally {
      closeSync(fd);
    }
    return events.map(event => event.id);
  } catch (e) {
    console.error(`[taskbean] Event history append failed; the primary operation may already have succeeded: ${e.message}`);
    return null;
  }
}

function _normalizeActor(actor) {
  const a = actor || {};
  let host = null;
  try {
    const h = detectHost({ resolveWindowsHome: false });
    if (h.isWSL) host = 'wsl';
    else if (h.os === 'windows') host = 'windows';
    else if (h.os === 'macos') host = 'macos';
    else if (h.os === 'linux') host = 'linux';
  } catch { /* best-effort */ }
  return {
    agent: a.agent || null,
    sessionId: a.sessionId || null,
    host,
  };
}

/**
 * Write a default `.taskbean/.gitignore` once. Exists to make the gitignore
 * default *visible* to the developer rather than buried in tool behavior.
 *
 *   tasks.db*   — always ignored (derived cache, regenerable from events).
 *   events.jsonl — commented out by default (opt-in commit for shared
 *                  team task history; see plan §10 / §12).
 */
function _ensureGitignore(tbDir) {
  const gi = resolve(tbDir, '.gitignore');
  if (existsSync(gi)) return;
  const body = [
    '# taskbean — generated. Edit to taste.',
    '',
    '# Derived SQLite cache. Always ignore — regenerable from events.jsonl',
    '# via `bean rebuild`. Committing this file causes binary merge',
    '# conflicts with no automatic resolution.',
    'tasks.db',
    'tasks.db-shm',
    'tasks.db-wal',
    '',
    '# Append-only event log. The canonical task history.',
    '# Default: gitignored (personal task tracking).',
    '# Uncomment to commit for shared team task history — text-mergeable,',
    '# safe for git. See https://github.com/taskbean/taskbean (plan §12).',
    '#events.jsonl',
    'events.jsonl',
    '',
  ].join('\n');
  try {
    writeFileSync(gi, body, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

/**
 * Read events, rejecting malformed lines rather than replaying partial history.
 *
 * @param {string} projectPath
 * @returns {object[]}
 */
export async function readEvents(projectPath) {
  const filePath = resolve(projectPath, '.taskbean', 'events.jsonl');
  if (!existsSync(filePath)) return [];
  const { readFileSync } = await import('fs');
  const text = readFileSync(filePath, 'utf-8');
  const out = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid event at ${filePath}:${lineNo}; history was not replayed`, { cause: error });
    }
  }
  return out;
}

export const _SCHEMA_VERSION = SCHEMA_VERSION;
