import { useEffect, useState } from 'react';
import hr from '../api/hr';
import { useToast } from '../hooks/useToast';
import { Button } from './ui';
import { Icon } from './Icon';
import { fmtDuration, fmtTime } from '../api/format';

/** Seconds in a shift window like "09:00:00"–"18:00:00". Returns null when
 *  either end is unset, so the progress bar is simply omitted rather than
 *  drawn against a made-up target. */
function shiftSeconds(shift) {
  if (!shift?.start_time || !shift?.end_time) return null;
  const parse = (t) => {
    const [h, m, s] = String(t).split(':').map(Number);
    return Number.isFinite(h) ? h * 3600 + (m || 0) * 60 + (s || 0) : null;
  };
  const start = parse(shift.start_time);
  const end = parse(shift.end_time);
  if (start === null || end === null) return null;
  // A shift crossing midnight ends on the next day.
  return end > start ? end - start : 86400 - start + end;
}

export default function PunchHero({ today, defaultShift, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const checkedIn = Boolean(today?.checked_in);
  const base = Number(today?.working_seconds) || 0;

  // While checked in the server's count goes stale immediately, so the clock
  // continues locally. The anchor is captured inside the effect and reset
  // whenever a fresh payload lands, so the local elapsed time is never added
  // to a server count that already contains it. Elapsed is measured from that
  // timestamp rather than counted in ticks, so a throttled background tab
  // cannot make the clock run slow.
  const [worked, setWorked] = useState(base);
  useEffect(() => {
    setWorked(base);
    if (!checkedIn) return undefined;
    const anchor = Date.now();
    const id = setInterval(
      () => setWorked(base + Math.max(0, Math.floor((Date.now() - anchor) / 1000))),
      1000,
    );
    return () => clearInterval(id);
  }, [checkedIn, base]);

  const target = shiftSeconds(defaultShift);
  const pct = target ? Math.min(100, (worked / target) * 100) : null;

  const punch = async (logType) => {
    setBusy(true);
    try {
      await hr.checkInOut(logType);
      toast.success(logType === 'IN' ? 'Checked in.' : 'Checked out.');
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="punch">
      <div className="punch__lead">
        <div className="punch__label">
          {checkedIn ? 'Checked in' : today?.first_in ? 'Checked out' : 'Not checked in'}
        </div>
        <div className="punch__clock">
          {fmtDuration(worked)}
          {target && <span className="punch__of">of {fmtDuration(target)}</span>}
        </div>
        {pct !== null && (
          <div className="punch__bar"><div className="punch__fill" style={{ width: `${pct}%` }} /></div>
        )}
      </div>

      <div className="punch__facts">
        <div>
          <div className="punch__fact-label">In</div>
          <div className="punch__fact-value">{today?.first_in ? fmtTime(today.first_in) : '—'}</div>
        </div>
        <div>
          <div className="punch__fact-label">Last log</div>
          <div className="punch__fact-value">{today?.last_log ? fmtTime(today.last_log) : '—'}</div>
        </div>
        <div>
          <div className="punch__fact-label">Shift</div>
          <div className="punch__fact-value">{today?.shift || defaultShift?.shift_type || '—'}</div>
          {defaultShift?.start_time && defaultShift?.end_time && (
            <div className="punch__fact-meta">
              {String(defaultShift.start_time).slice(0, 5)} – {String(defaultShift.end_time).slice(0, 5)}
            </div>
          )}
        </div>
        {(today?.late_entry || today?.early_exit) && (
          <div>
            <div className="punch__fact-label">Flags</div>
            <div className="punch__fact-value">
              {[today.late_entry ? 'Late in' : null, today.early_exit ? 'Early out' : null]
                .filter(Boolean).join(' · ')}
            </div>
          </div>
        )}
      </div>

      <Button
        variant={checkedIn ? 'indigo' : 'primary'}
        onClick={() => punch(checkedIn ? 'OUT' : 'IN')}
        disabled={busy}
      >
        <Icon name="clock" size={15} />
        {busy ? 'Saving…' : checkedIn ? 'Check out' : 'Check in'}
      </Button>
    </div>
  );
}
