/** Display helpers. Null means "unset", never zero — an unset value is
 *  omitted rather than rendered as a plausible default. */

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function toDate(value) {
  if (!value) return null;
  // Frappe returns "YYYY-MM-DD" and "YYYY-MM-DD HH:MM:SS"; the latter needs a
  // 'T' to parse consistently across browsers.
  const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date;
}

export const fmtDate = (v) => { const d = toDate(v); return d ? DATE_FMT.format(d) : '—'; };
export const fmtDateShort = (v) => { const d = toDate(v); return d ? DATE_SHORT.format(d) : '—'; };
export const fmtTime = (v) => { const d = toDate(v); return d ? TIME_FMT.format(d) : '—'; };
export const fmtDateTime = (v) => { const d = toDate(v); return d ? `${DATE_FMT.format(d)}, ${TIME_FMT.format(d)}` : '—'; };

export function fmtRange(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a) return '—';
  if (!b || a.getTime() === b.getTime()) return DATE_FMT.format(a);
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${sameYear ? DATE_SHORT.format(a) : DATE_FMT.format(a)} – ${DATE_FMT.format(b)}`;
}

export function fmtRelative(value) {
  const date = toDate(value);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return DATE_FMT.format(date);
}

export function fmtMoney(value, currency) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    return `${currency || ''} ${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`.trim();
  }
}

export function fmtNumber(value, digits = 1) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  return Number.isInteger(num) ? String(num) : num.toFixed(digits);
}

export function fmtDays(value) {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  const text = Number.isInteger(num) ? String(num) : num.toFixed(1);
  return `${text} ${num === 1 ? 'day' : 'days'}`;
}

export function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '0h 00m';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Frappe returns "1"/1/true and ""/null interchangeably. */
export const truthy = (v) => v === true || v === 1 || v === '1' || v === 'Yes';

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

export function monthLabel(value) {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

export function shiftMonth(value, delta) {
  const date = toDate(value) || new Date();
  return monthKey(new Date(date.getFullYear(), date.getMonth() + delta, 1));
}

export function isoDate(date) {
  const d = toDate(date) || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Maps a Frappe status/approval string onto a pill tone. */
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['approved', 'present', 'active', 'paid', 'submitted', 'completed', 'success', 'open position'].some((k) => s.includes(k))) return 'success';
  if (['rejected', 'cancelled', 'absent', 'failed', 'overdue', 'blocked'].some((k) => s.includes(k))) return 'danger';
  if (['open', 'draft', 'pending', 'half day', 'on hold', 'at risk', 'queued'].some((k) => s.includes(k))) return 'warning';
  if (['on leave', 'work from home', 'in progress'].some((k) => s.includes(k))) return 'info';
  return 'default';
}
