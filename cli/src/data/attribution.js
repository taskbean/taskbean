// Attribution: figure out which agent + native session id created a task.
//
// Four-tier precedence (highest wins):
//   1. Explicit flags:   bean add --agent=<name> --session-id=<native>
//   2. taskbean env:     TASKBEAN_AGENT + TASKBEAN_NATIVE_SESSION_ID
//   3. Vendor env vars:  CLAUDECODE, CODEX_SESSION_ID, OPENCODE_SESSION, COPILOT_CLI_SESSION_ID
//   4. CWD + ±30min heuristic against `agent_sessions` (populated by the PWA ingester)
//
// Ambiguous signals (tier 2/3 disagree, or tier 4 finds multiple agents) -> return null.
// We do NOT guess "most recent" when sources conflict.
//
// CLI is READ-ONLY for agent_sessions / agent_turns / agent_sources / agent_settings.
// This module only stamps todos.agent + todos.agent_session_id.

import { realpathSync } from 'fs';
import { sep as pathSep } from 'path';
import { allRows } from './store.js';

export const AGENTS = ['copilot', 'claude-code', 'codex', 'opencode'];

const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;

/** Windows-aware realpath + case-fold (mirrors Python `canonical_cwd`). */
export function canonicalCwd(p) {
  if (!p) return null;
  let resolved;
  try {
    resolved = realpathSync(p);
  } catch {
    resolved = p;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAncestorOrSame(candidate, child) {
  if (!candidate || !child) return false;
  if (candidate === child) return true;
  const prefix = candidate.endsWith(pathSep) ? candidate : candidate + pathSep;
  return child.startsWith(prefix);
}

/** Tier 3: vendor env var detection. */
function fromVendorEnv(env = process.env) {
  const hits = [];
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE || env.ANTHROPIC_CLI) {
    hits.push({ agent: 'claude-code', nativeId: env.CLAUDE_SESSION_ID || null });
  }
  if (env.CODEX_SESSION_ID || env.CODEX_HOME) {
    hits.push({ agent: 'codex', nativeId: env.CODEX_SESSION_ID || null });
  }
  if (env.OPENCODE_SESSION || env.OPENCODE_SESSION_ID) {
    hits.push({ agent: 'opencode', nativeId: env.OPENCODE_SESSION || env.OPENCODE_SESSION_ID || null });
  }
  if (env.COPILOT_CLI_SESSION_ID || env.COPILOT_SESSION_ID) {
    hits.push({ agent: 'copilot', nativeId: env.COPILOT_CLI_SESSION_ID || env.COPILOT_SESSION_ID });
  }
  // Exactly one vendor env var tier-3 hit is the only unambiguous case.
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: true };
  return null;
}

/** Tier 4: cwd+time lookup against PWA-populated agent_sessions. */
function fromCwdHeuristic(cwd, nowIso) {
  if (!cwd) return null;
  const cutoffMs = new Date(nowIso).getTime() - ATTRIBUTION_WINDOW_MS;
  const cutoffFuture = new Date(nowIso).getTime() + ATTRIBUTION_WINDOW_MS;

  let rows;
  try {
    rows = allRows(
      `SELECT s.agent, s.native_id, s.cwd, s.started_at, s.updated_at
       FROM agent_sessions s
       LEFT JOIN agent_settings g ON g.agent = s.agent
       WHERE COALESCE(g.enabled, 1) = 1
         AND s.cwd IS NOT NULL
       ORDER BY s.updated_at DESC`
    );
  } catch {
    return null; // Tables not yet created
  }

  const candidates = [];
  for (const r of rows) {
    if (!isAncestorOrSame(r.cwd, cwd)) continue;
    const t = new Date(r.updated_at || r.started_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t < cutoffMs || t > cutoffFuture) continue;
    candidates.push({ agent: r.agent, nativeId: r.native_id, t });
  }
  if (candidates.length === 0) return null;

  // One agent, any number of sessions: pick most recent.
  const agents = new Set(candidates.map((c) => c.agent));
  if (agents.size === 1) {
    candidates.sort((a, b) => b.t - a.t);
    return { agent: candidates[0].agent, nativeId: candidates[0].nativeId };
  }
  // Multiple agents within the window → ambiguous (per plan: null, never guess).
  return { ambiguous: true };
}

/**
 * Resolve { agent, nativeId } for a new task.
 * @param {object} opts
 * @param {string=} opts.agent        --agent flag
 * @param {string=} opts.sessionId    --session-id flag (legacy Copilot + new native)
 * @param {string=} opts.cwd          Usually process.cwd()
 * @param {string=} opts.now          ISO timestamp (defaults to now)
 * @param {object=} opts.env          For tests
 * @returns {{agent: (string|null), nativeId: (string|null), source: string}}
 */
export function resolveAttribution(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || new Date().toISOString();
  const cwd = canonicalCwd(opts.cwd || process.cwd());

  // Tier 1: explicit flags.
  if (opts.agent && AGENTS.includes(opts.agent)) {
    return { agent: opts.agent, nativeId: opts.sessionId || null, source: 'flag' };
  }
  // Legacy: --session-id only (no --agent) → assume Copilot (back-compat for
  // existing agents that already pass --session-id for Copilot correlation).
  if (opts.sessionId && !opts.agent) {
    return { agent: 'copilot', nativeId: opts.sessionId, source: 'flag-legacy' };
  }

  // Tier 2: taskbean-owned env (set by skill wrappers).
  const tbAgent = env.TASKBEAN_AGENT;
  const tbSession = env.TASKBEAN_NATIVE_SESSION_ID;
  if (tbAgent && AGENTS.includes(tbAgent)) {
    return { agent: tbAgent, nativeId: tbSession || null, source: 'taskbean-env' };
  }

  // Tier 3: vendor env vars.
  const vendor = fromVendorEnv(env);
  if (vendor && !vendor.ambiguous) {
    return { agent: vendor.agent, nativeId: vendor.nativeId, source: 'vendor-env' };
  }
  if (vendor && vendor.ambiguous) {
    return { agent: null, nativeId: null, source: 'ambiguous-vendor-env' };
  }

  // Tier 4: cwd + ±30min heuristic.
  const guess = fromCwdHeuristic(cwd, now);
  if (guess && !guess.ambiguous) {
    return { agent: guess.agent, nativeId: guess.nativeId, source: 'cwd-heuristic' };
  }
  if (guess && guess.ambiguous) {
    return { agent: null, nativeId: null, source: 'ambiguous-cwd' };
  }

  return { agent: null, nativeId: null, source: 'none' };
}
