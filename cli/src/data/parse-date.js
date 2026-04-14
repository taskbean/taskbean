/**
 * Parse natural language date/time strings into ISO date strings.
 * Lightweight — no external deps. Handles common patterns:
 * - "tomorrow", "today", "yesterday"
 * - "monday", "tuesday", etc. (next occurrence)
 * - "in 2 hours", "in 30 minutes", "in 3 days"
 * - "friday 9am", "tomorrow 3pm"
 * - ISO dates pass through
 */
export function parseDate(input) {
  if (!input) return null;
  const str = input.toLowerCase().trim();
  const now = new Date();

  // ISO date passthrough
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str;

  // "today", "tomorrow", "yesterday"
  if (str === 'today') return formatDate(now);
  if (str === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return formatDateTime(d, extractTime(str));
  }
  if (str === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  // "in X hours/minutes/days/weeks"
  const inMatch = str.match(/^in\s+(\d+)\s+(hour|hr|minute|min|day|week)s?$/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2];
    const d = new Date(now);
    if (unit.startsWith('hour') || unit === 'hr') d.setHours(d.getHours() + n);
    else if (unit.startsWith('min')) d.setMinutes(d.getMinutes() + n);
    else if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'week') d.setDate(d.getDate() + n * 7);
    return formatDateTime(d);
  }

  // Day names: "monday", "friday 9am", "tomorrow 3pm"
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const parts = str.split(/\s+/);
  const dayName = parts[0];
  const timeStr = parts.slice(1).join(' ');

  // Check for "tomorrow 9am" pattern
  if (dayName === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return formatDateTime(d, parseTime(timeStr));
  }

  const dayIdx = days.indexOf(dayName);
  if (dayIdx !== -1) {
    const d = new Date(now);
    const currentDay = d.getDay();
    let daysAhead = dayIdx - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    d.setDate(d.getDate() + daysAhead);
    return formatDateTime(d, parseTime(timeStr));
  }

  // Fallback: return as-is (let caller handle)
  return str;
}

function parseTime(str) {
  if (!str) return null;
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2] || '0');
  const period = (match[3] || '').toLowerCase();
  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  return { hours, minutes };
}

function extractTime(str) {
  const match = str.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  return match ? parseTime(match[1]) : null;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function formatDateTime(d, time) {
  if (time) {
    d.setHours(time.hours, time.minutes, 0, 0);
  }
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}
