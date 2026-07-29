import { discoverChronicleCapabilities } from '../chronicle/adapter.js';
import { reconcileChronicleSessions } from '../chronicle/reconcile.js';
import {
  approveSuggestion,
  ignoreSuggestion,
  linkSuggestion,
  listSuggestions,
  undoAutoLinkSuggestion,
} from '../chronicle/suggestions.js';

function renderStatus(label, item) {
  const suffix = item.path ? ` (${item.path})` : '';
  if (item.status === 'available') return `${label}: available${suffix}`;
  if (item.status === 'missing') return `${label}: missing${suffix}`;
  return `${label}: ${item.status}${item.error ? ` - ${item.error}` : ''}${suffix}`;
}

function renderDoctorText(result) {
  const lines = [
    'Chronicle/session capability doctor',
    '',
    renderStatus('Local session-state', result.localSessionState),
    renderStatus('Local session-store', result.localSessionStore),
    `Chronicle slash command: ${result.chronicleSlashCommand.status}`,
    `Remote sync: ${result.remoteSync.status}`,
    '',
    'Privacy defaults:',
    `- Local-only adapter: ${result.privacy.localOnly ? 'yes' : 'no'}`,
    `- Stores raw messages: ${result.privacy.storesRawMessages ? 'yes' : 'no'}`,
    `- Ignores raw message columns: ${result.privacy.rawMessageColumnsIgnored ? 'yes' : 'no'}`,
  ];

  if (result.localSessionStore.status === 'available') {
    lines.push('');
    lines.push(`Session-store schema version: ${result.localSessionStore.schemaVersion ?? 'unknown'}`);
    const expected = result.localSessionStore.tables || {};
    for (const [name, table] of Object.entries(expected)) {
      lines.push(`- ${name}: ${table.present ? 'present' : 'missing'}`);
    }
  }

  if (result.limitations.length) {
    lines.push('');
    lines.push('Limitations:');
    for (const item of result.limitations) lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

export function chronicleDoctorCommand(opts) {
  const result = discoverChronicleCapabilities();
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderDoctorText(result));
}

function renderReconcileText(result) {
  const lines = [
    `Chronicle reconciliation: ${result.since} to ${result.until}`,
    '',
  ];

  if (!result.available) {
    lines.push(`Chronicle/session evidence unavailable: ${result.reason}`);
    return lines.join('\n');
  }

  lines.push(`Discovered sessions: ${result.counts.discovered}`);
  lines.push(`Pending suggestions: ${result.counts.pending}`);
  lines.push(`Created: ${result.counts.created}`);
  lines.push(`Updated: ${result.counts.updated}`);

  if (result.suggestions.length) {
    lines.push('');
    lines.push('Suggestions:');
    for (const suggestion of result.suggestions) {
      lines.push(`- ${suggestion.id} (${suggestion.state}, confidence ${suggestion.confidence}): ${suggestion.suggested_title}`);
    }
  }

  return lines.join('\n');
}

export function chronicleReconcileCommand(opts) {
  try {
    const result = reconcileChronicleSessions(opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderReconcileText(result));
  } catch (err) {
    const payload = { error: 'chronicle_reconcile_failed', message: err.message };
    if (opts.json) {
      console.log(JSON.stringify(payload));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

function handleSuggestionCommand(opts, fn) {
  try {
    const result = fn();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderSuggestionText(result));
    }
  } catch (err) {
    const payload = { error: err.code || 'chronicle_suggestion_failed', message: err.message };
    if (opts.json) {
      console.log(JSON.stringify(payload));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

function renderSuggestionText(result) {
  if (Array.isArray(result.suggestions)) {
    if (!result.suggestions.length) return 'No Chronicle reconciliation suggestions found.';
    return result.suggestions
      .map(s => `${s.id} (${s.state}, confidence ${s.confidence}): ${s.suggested_title}`)
      .join('\n');
  }
  if (result.action === 'approve') return `Approved suggestion ${result.suggestion.id} into task ${result.task.id}`;
  if (result.action === 'link') return `Linked suggestion ${result.suggestion.id} to task ${result.task.id}`;
  if (result.action === 'ignore') return `Ignored suggestion ${result.suggestion.id}`;
  if (result.action === 'undo-auto-link') return `Returned auto-linked suggestion ${result.suggestion.id} to pending review`;
  return JSON.stringify(result, null, 2);
}

export function chronicleSuggestionsCommand(opts) {
  handleSuggestionCommand(opts, () => listSuggestions(opts));
}

export function chronicleApproveCommand(suggestionId, opts) {
  handleSuggestionCommand(opts, () => approveSuggestion(suggestionId, opts));
}

export function chronicleLinkCommand(suggestionId, todoId, opts) {
  handleSuggestionCommand(opts, () => linkSuggestion(suggestionId, todoId, opts));
}

export function chronicleIgnoreCommand(suggestionId, opts) {
  handleSuggestionCommand(opts, () => ignoreSuggestion(suggestionId));
}

export function chronicleUndoCommand(suggestionId, opts) {
  handleSuggestionCommand(opts, () => undoAutoLinkSuggestion(suggestionId));
}
