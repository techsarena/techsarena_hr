import { useMemo } from 'react';
import { fmtDate, fmtTime, isoDate, statusTone, toDate, truthy } from '../api/format';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Which visual class a day earns. Order matters: a missing punch outranks
 *  the status it was marked with, because that is the day needing action. */
function dayClass({ record, holiday, weekend, needsAction }) {
  if (needsAction) return 'missing';
  if (holiday) return 'holiday';
  const status = String(record?.status || '').toLowerCase();
  if (status.includes('work from home')) return 'wfh';
  if (status.includes('half')) return 'present';
  if (status.includes('present')) return 'present';
  if (status.includes('leave')) return 'leave';
  if (status.includes('absent')) return 'absent';
  if (weekend) return 'weekend';
  return null;
}

export function AttendanceMonthLegend() {
  return (
    <div className="cal__legend">
      <span className="cal__legend-item"><span className="cal__dot" style={{ background: 'var(--accent-700)' }} />Present</span>
      <span className="cal__legend-item"><span className="cal__dot" style={{ background: 'var(--secondary-300)' }} />Work from home</span>
      <span className="cal__legend-item"><span className="cal__dot" style={{ background: 'var(--primary-400)' }} />Leave</span>
      <span className="cal__legend-item"><span className="cal__dot" style={{ background: 'var(--danger)' }} />Missing punch</span>
    </div>
  );
}

export function AttendanceMonth({ month, days = [], holidays = [], needsAction = [], onPick }) {
  const cells = useMemo(() => {
    const anchor = toDate(month) || new Date();
    const year = anchor.getFullYear();
    const mi = anchor.getMonth();
    const total = new Date(year, mi + 1, 0).getDate();

    const byDate = new Map(days.map((d) => [String(d.attendance_date), d]));
    const holidayBy = new Map(holidays.map((h) => [String(h.holiday_date), h]));
    const actionBy = new Set(needsAction.map((n) => String(n.date)));

    // Monday-first, so the weekend falls at the end of each row.
    const lead = (new Date(year, mi, 1).getDay() + 6) % 7;
    const list = Array.from({ length: lead }, (unused, i) => ({ pad: true, key: `pad-${i}` }));
    for (let day = 1; day <= total; day += 1) {
      const date = new Date(year, mi, day);
      const key = isoDate(date);
      const dow = date.getDay();
      list.push({
        key,
        day,
        record: byDate.get(key),
        holiday: holidayBy.get(key),
        weekend: dow === 0 || dow === 6,
        needsAction: actionBy.has(key),
      });
    }
    return list;
  }, [month, days, holidays, needsAction]);

  const today = isoDate(new Date());

  return (
    <div className="amonth">
      <div className="amonth__head">
        {DOW.map((d) => <div className="amonth__dow" key={d}>{d}</div>)}
      </div>
      <div className="amonth__grid">
        {cells.map((cell) => {
          if (cell.pad) return <div className="aday aday--pad" key={cell.key} />;

          const kind = dayClass(cell);
          const isToday = cell.key === today;
          const classes = ['aday'];
          if (kind) classes.push(`aday--${kind}`);
          // Nothing recorded and nothing scheduled: draw it as a faint outline
          // so the days that do carry punches are what the eye lands on.
          if (!kind && !cell.record) classes.push('aday--empty');
          if (isToday) classes.push('aday--today');

          const rec = cell.record;
          const times = rec?.in_time
            ? `${fmtTime(rec.in_time)}${rec.out_time ? ` – ${fmtTime(rec.out_time)}` : ''}`
            : null;

          // A day with nothing recorded is not clickable: there is no
          // regularisation to request against an empty future date.
          const actionable = Boolean(onPick && (rec || cell.needsAction) && cell.key <= today);

          return (
            <button
              type="button"
              key={cell.key}
              className={classes.join(' ')}
              disabled={!actionable}
              onClick={actionable ? () => onPick(cell.key) : undefined}
              title={[fmtDate(cell.key), rec?.status, cell.holiday?.description].filter(Boolean).join(' · ')}
            >
              <div className="aday__top">
                <span className="aday__num">{cell.day}</span>
                {isToday && <span className="aday__today">Today</span>}
                {cell.needsAction && !isToday && <span className="aday__alert" aria-hidden="true">!</span>}
              </div>

              {cell.needsAction ? (
                <div className="aday__note aday__note--danger">No check-out</div>
              ) : cell.holiday && !truthy(cell.holiday.weekly_off) ? (
                <div className="aday__note aday__note--holiday">
                  {cell.holiday.description || 'Holiday'}
                </div>
              ) : times ? (
                <div className="aday__time">
                  <span className="aday__range">{times}</span>
                  {rec?.working_hours ? <span className="aday__hours">{Number(rec.working_hours).toFixed(1)}h</span> : null}
                </div>
              ) : rec?.status ? (
                <div
                  className="aday__note"
                  style={{ color: `var(--${statusTone(rec.status) === 'default' ? 'text-muted' : statusTone(rec.status)})` }}
                >
                  {rec.status}
                </div>
              ) : cell.weekend ? (
                <div className="aday__note aday__note--weekend">Weekend</div>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default AttendanceMonth;
