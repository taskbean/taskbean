import { discoverChronicleCapabilities } from '../chronicle/adapter.js';

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

