import { useMemo } from 'react';
import { Avatar } from './ui';
import { isoDate, toDate, truthy } from '../api/format';
import { t } from '../api/i18n';

/** Leave types map onto four swatches; anything unrecognised takes `other`
 *  rather than inventing a colour per type. */
function leaveTone(leaveType) {
  const s = String(leaveType || '').toLowerCase();
  if (s.includes('privilege') || s.includes('earned') || s.includes('annual')) return 'privilege';
  if (s.includes('sick')) return 'sick';
  if (s.includes('casual')) return 'casual';
  return 'other';
}

/** Approved days render solid, pending days hatched — the two must never
 *  look alike, since one is cover you can count on and one is not. */
function isPending(status) {
  return String(status || '').toLowerCase() === 'open';
}

const DAY_MS = 86400000;

/** Every ISO date from `from` to `to` inclusive, walked in UTC so a DST
 *  boundary inside the month cannot drop or double a day. */
function eachDay(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) return [];
  const days = [];
  let cursor = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const last = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    const d = new Date(cursor);
    days.push({
      iso: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
    });
    cursor += DAY_MS;
  }
  return days;
}

/**
 * Builds `employee -> iso -> {tone, pending}` from the leave rows, expanding
 * each row across its own date span. Rows are keyed by employee id where the
 * server sends one, falling back to the name so a payload without ids still
 * groups rather than collapsing everyone into one row.
 */
function buildIndex(rows, days) {
  const within = new Set(days.map((d) => d.iso));
  const people = new Map();

  for (const row of rows) {
    const key = row.employee || row.employee_name;
    if (!key) continue;
    if (!people.has(key)) {
      people.set(key, {
        key,
        name: row.employee_name || key,
        department: row.department || null,
        image: row.image || null,
        days: new Map(),
      });
    }
    const person = people.get(key);
    const tone = leaveTone(row.leave_type);
    const pending = isPending(row.status);

    for (const { iso } of eachDay(row.from_date, row.to_date || row.from_date)) {
      if (!within.has(iso)) continue;
      // An approved day wins over a pending one on the same date, so cover
      // never reads as uncertain when part of it is already granted.
      const existing = person.days.get(iso);
      if (existing && !existing.pending) continue;
      person.days.set(iso, { tone, pending, leaveType: row.leave_type });
    }
  }

  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const LEGEND = [
  { tone: 'privilege', label: t("Privilege") },
  { tone: 'sick', label: t("Sick") },
  { tone: 'casual', label: t("Casual") },
  { tone: 'other', label: t("Other") },
];

export function TeamCalendarGrid({ from, to, rows = [], holidays = [], currentEmployee, approverEmployee }) {
  const days = useMemo(() => eachDay(from, to), [from, to]);
  const people = useMemo(() => buildIndex(rows, days), [rows, days]);

  const holidayIndex = useMemo(() => {
    const map = new Map();
    for (const h of holidays) {
      const d = toDate(h.holiday_date);
      if (!d) continue;
      map.set(isoDate(d), { description: h.description, weeklyOff: truthy(h.weekly_off) });
    }
    return map;
  }, [holidays]);

  const today = isoDate(new Date());

  if (!days.length) return null;

  return (
    <div className="cal" style={{ '--cal-days': days.length }}>
      <div className="cal__scroll">
        <div className="cal__grid">
          <div className="cal__ruler">
            <div className="cal__ruler-spacer" />
            {days.map((d) => {
              const holiday = holidayIndex.get(d.iso);
              return (
                <div
                  key={d.iso}
                  className={[
                    'cal__daynum',
                    d.iso === today ? 'is-today' : '',
                    holiday && !holiday.weeklyOff ? 'is-holiday' : '',
                    d.weekday === 0 || d.weekday === 6 ? 'is-weekend' : '',
                  ].filter(Boolean).join(' ')}
                  title={holiday?.description || undefined}
                >
                  {d.day}
                </div>
              );
            })}
          </div>

          {people.map((person) => (
            <div className="cal__row" key={person.key}>
              <div className="cal__person">
                <Avatar name={person.name} src={person.image || undefined} size="sm" />
                <div className="truncate">
                  <div className="cal__person-name truncate">{person.name}</div>
                  {person.key === currentEmployee ? (
                    <div className="cal__person-meta cal__person-meta--you">{t("You")}</div>
                  ) : person.key === approverEmployee ? (
                    <div className="cal__person-meta cal__person-meta--approver">{t("Your approver")}</div>
                  ) : person.department ? (
                    <div className="cal__person-meta truncate">{person.department}</div>
                  ) : null}
                </div>
              </div>

              {days.map((d) => {
                const entry = person.days.get(d.iso);
                const holiday = holidayIndex.get(d.iso);
                const classes = ['cal__cell'];
                if (d.weekday === 0 || d.weekday === 6) classes.push('cal__cell--weekend');

                if (entry) {
                  classes.push(entry.pending ? 'cal__cell--pending' : `cal__cell--${entry.tone}`);
                } else if (holiday) {
                  classes.push(holiday.weeklyOff ? 'cal__cell--off' : 'cal__cell--holiday');
                }
                if (d.iso === today && !entry) classes.push('cal__cell--today');

                const label = entry
                  ? `${person.name} — ${entry.leaveType || 'Leave'}${entry.pending ? ' (pending)' : ''}`
                  : holiday?.description || undefined;

                return <div key={d.iso} className={classes.join(' ')} title={label} />;
              })}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

/** The colour key. Rendered beside the card title rather than under the grid,
 *  so it is readable before the eye reaches the cells it explains. */
export function TeamCalendarLegend() {
  return (
    <div className="cal__legend">
      {LEGEND.map((item) => (
        <span className="cal__legend-item" key={item.tone}>
          <span className={`cal__swatch cal__cell--${item.tone}`} />
          {item.label}
        </span>
      ))}
      <span className="cal__legend-item">
        <span className="cal__swatch cal__cell--pending" />
        Pending
      </span>
      <span className="cal__legend-item">
        <span className="cal__swatch cal__cell--holiday" />
        Holiday
      </span>
    </div>
  );
}

export default TeamCalendarGrid;
