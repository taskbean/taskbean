// Report periods use local calendar days. Stored timestamps are mostly UTC ISO
// strings, so filters compare instants, not the UTC date prefix.

function localDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Returns { since, until, label, start, end }: since/until are local
 * YYYY-MM-DD (inclusive), start/end are ISO instants (end exclusive).
 */
export function getDateRange(range, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = days => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
  let since;
  let until;
  let label;
  switch (range) {
    case 'yesterday':
      since = until = localDateString(shift(-1));
      label = 'Yesterday';
      break;
    case 'week':
      since = localDateString(shift(-7));
      until = localDateString(today);
      label = 'This Week';
      break;
    case 'all':
      return {
        since: '1970-01-01', until: '2099-12-31', label: 'All Time',
        start: '1970-01-01T00:00:00.000Z', end: '2100-01-01T00:00:00.000Z',
      };
    case 'today':
    default:
      since = until = localDateString(today);
      label = 'Today';
  }
  const endDay = localMidnight(until);
  endDay.setDate(endDay.getDate() + 1);
  return { since, until, label, start: localMidnight(since).toISOString(), end: endDay.toISOString() };
}

/**
 * Parse a stored timestamp to epoch ms. ISO strings with Z or an offset are
 * instants; naive "YYYY-MM-DD HH:MM:SS" and date-only values are local time.
 */
export function parseInstant(value) {
  if (!value || typeof value !== 'string') return NaN;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return localMidnight(s).getTime();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0').padEnd(3, '0').slice(0, 3))).getTime();
  }
  return Date.parse(s);
}

export function inPeriod(value, range) {
  const t = parseInstant(value);
  return Number.isFinite(t) && t >= Date.parse(range.start) && t < Date.parse(range.end);
}

export function formatLocal(value) {
  const t = parseInstant(value);
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t);
  return `${localDateString(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
