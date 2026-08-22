import { useEffect, useState } from 'react';
import hr from '../api/hr';
import { useToast } from '../hooks/useToast';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Button, Drawer, Field, FieldRow } from './ui';
import { fmtDays, isoDate } from '../api/format';

/* ---------- Apply drawer ---------- */
export function ApplyDrawer({ open, onClose, onDone }) {
  const { leaveBalances, reload } = useWorkspace();
  const toast = useToast();
  const [form, setForm] = useState({
    leave_type: '',
    from_date: isoDate(new Date()),
    to_date: isoDate(new Date()),
    half_day: false,
    description: '',
  });
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [busy, setBusy] = useState(false);

  const { leave_type, from_date, to_date, half_day } = form;

  /* The day count and resulting balance come from HRMS's own working-day
     maths (leave_preview) — never computed here, or the preview would
     disagree with what actually gets deducted. */
  useEffect(() => {
    if (!open || !leave_type || !from_date || !to_date) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    setPreviewError(null);
    hr.leavePreview(leave_type, from_date, to_date, half_day ? 1 : 0)
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch((error) => { if (!cancelled) { setPreview(null); setPreviewError(error); } });
    return () => { cancelled = true; };
  }, [open, leave_type, from_date, to_date, half_day]);

  const submit = async () => {
    setBusy(true);
    try {
      await hr.submitLeave({
        leave_type: form.leave_type,
        from_date: form.from_date,
        to_date: form.to_date,
        half_day: form.half_day ? 1 : 0,
        description: form.description,
      });
      toast.success('Leave request submitted.');
      onClose();
      await reload();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Apply for leave"
      subtitle="Day count comes from your leave type's own working-day rules"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !form.leave_type || Boolean(previewError)}>
            {busy ? 'Submitting…' : 'Submit request'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Leave type">
          <select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
            <option value="">Select a leave type…</option>
            {leaveBalances.map((row) => (
              <option key={row.leave_type} value={row.leave_type}>
                {row.leave_type} — {Number(row.remaining).toFixed(1)} left
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid--2">
          <Field label="From">
            <input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} />
          </Field>
        </div>

        <label className="row" style={{ gap: 8, marginBottom: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={form.half_day}
            onChange={(e) => setForm({ ...form, half_day: e.target.checked })}
          />
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>Half day</span>
        </label>

        <Field label="Reason">
          <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        {previewError && (
          <div className="login__error" style={{ margin: 0 }}>{previewError.message}</div>
        )}

        {preview && (
          <div className="card card--muted">
            <div className="section-heading__label" style={{ marginBottom: 8 }}>Before you submit</div>
            <FieldRow label="Working days deducted" value={fmtDays(preview.working_days)} />
            {/* Null balance means this type is not allocated (e.g. LWP) — shown
                as "not allocated", never as a balance of 0. */}
            <FieldRow
              label="Balance now"
              value={preview.balance_before === null || preview.balance_before === undefined ? 'Not allocated' : fmtDays(preview.balance_before)}
            />
            <FieldRow
              label="Balance after"
              value={preview.balance_after === null || preview.balance_after === undefined ? null : fmtDays(preview.balance_after)}
            />
            {(preview.holidays || []).length > 0 && (
              <FieldRow label="Holidays in range" value={`${preview.holidays.length} excluded`} />
            )}
            {preview.team_size > 0 && (
              <FieldRow
                label="Team cover"
                value={`${preview.team_leave.length} of ${preview.team_size} already away`}
              />
            )}
            {!preview.sufficient_balance && (
              <p className="small" style={{ color: 'var(--warning)', marginTop: 8 }}>
                This request exceeds your available balance.
              </p>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

export default ApplyDrawer;
