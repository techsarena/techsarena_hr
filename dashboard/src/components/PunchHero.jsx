import { useEffect, useState } from 'react';
import hr from '../api/hr';
import { useToast } from '../hooks/useToast';
import { useOffline } from '../hooks/useOffline';
import { Button } from './ui';
import { Icon } from './Icon';
import { fmtDuration, fmtDurationShort, fmtTime, toDate } from '../api/format';
import { t } from '../api/i18n';

const HERO_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

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
  const { refreshQueue } = useOffline();
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
      // The client's own clock is sent so a punch queued offline is recorded at
      // the moment it happened, not the moment the queue drained.
      const punchedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const result = await hr.checkInOut(logType, punchedAt);
      if (result?.queued) {
        // Saying "Checked in" here would be a lie — nothing reached the server.
        toast.push(
          logType === 'IN'
            ? t('Saved offline. Your check-in will send when you reconnect.')
            : t('Saved offline. Your check-out will send when you reconnect.'),
          'default',
          7000,
        );
        refreshQueue();
      } else {
        toast.success(logType === 'IN' ? t('Checked in.') : t('Checked out.'));
      }
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const breakSeconds = Number(today?.break_seconds) || 0;
  const state = checkedIn ? 'Checked in' : today?.first_in ? 'Checked out' : 'Not checked in';
  const stamp = toDate(today?.first_in) || new Date();
  const shiftName = today?.shift || defaultShift?.shift_type;
  const shiftWindow = defaultShift?.start_time && defaultShift?.end_time
    ? `${String(defaultShift.start_time).slice(0, 5)} – ${String(defaultShift.end_time).slice(0, 5)}`
    : null;
  const flags = [today?.late_entry ? 'Late in' : null, today?.early_exit ? 'Early out' : null].filter(Boolean);

  return (
    <div className="punch">
      <div className="punch__lead">
        <div className="punch__label">{state} · {HERO_DATE.format(stamp)}</div>
        <div className="punch__clock">
          {fmtDuration(worked)}
          {target && <span className="punch__of">of {fmtDuration(target)}</span>}
        </div>
        {pct !== null && (
          <div className="punch__bar"><div className="punch__fill" style={{ width: `${pct}%` }} /></div>
        )}
      </div>

      <div className="punch__facts">
        <div className="punch__fact">
          <div className="punch__fact-label">In</div>
          <div className="punch__fact-value">{today?.first_in ? fmtTime(today.first_in) : '—'}</div>
          <div className="punch__fact-meta">
            {today?.location || (today?.last_log ? `Last log ${fmtTime(today.last_log)}` : ' ')}
          </div>
        </div>
        {breakSeconds > 0 && (
          <div className="punch__fact">
            <div className="punch__fact-label">{t("Break")}</div>
            <div className="punch__fact-value">{fmtDurationShort(breakSeconds)}</div>
            <div className="punch__fact-meta">{' '}</div>
          </div>
        )}
        <div className="punch__fact">
          <div className="punch__fact-label">{t("Shift")}</div>
          <div className="punch__fact-value">{shiftName || '—'}</div>
          <div className="punch__fact-meta">{shiftWindow || ' '}</div>
        </div>
        {flags.length > 0 && (
          <div className="punch__fact">
            <div className="punch__fact-label">{t("Flags")}</div>
            <div className="punch__fact-value punch__fact-value--warn">{flags.join(' · ')}</div>
          </div>
        )}
      </div>

      <Button
        className="punch__action"
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
