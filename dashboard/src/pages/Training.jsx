/**
 * Training and certifications.
 *
 * The data model is HRMS's own — Training Event, its attendee child table, and
 * Training Feedback. Nothing is duplicated here; this is the self-service
 * surface those records never had. Certifications are Employee Documents
 * filtered to the qualification types, so they share the expiry sweep that
 * already warns people before a licence lapses.
 */
import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { t } from '../api/i18n';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useAsync, useMutation } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Avatar, Button, Card, Drawer, EmptyState, Field, FieldRow, Pill } from '../components/ui';
import { Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDateShort } from '../api/format';

const EXPIRY_TONE = { expired: 'danger', expiring: 'warning', valid: 'success', none: undefined };

const EXPIRY_LABEL = (row) => {
  if (row.expiry_state === 'expired') return t('Expired {0}', [fmtDateShort(row.expires_on)]);
  if (row.expiry_state === 'expiring') return t('Renew in {0}d', [row.days_to_expiry]);
  if (row.expiry_state === 'valid') return t('Valid to {0}', [fmtDateShort(row.expires_on)]);
  return t('No expiry');
};

/** Events carry a datetime; only the day and start time are worth showing. */
const whenLabel = (event) => {
  if (!event.start_time) return null;
  const day = fmtDate(event.start_time);
  const time = String(event.start_time).slice(11, 16);
  return time && time !== '00:00' ? `${day} · ${time}` : day;
};

export default function Training() {
  const { capabilities } = useWorkspace();
  const isHr = Boolean(capabilities.can_manage_hr);
  const [tab, setTab] = useState('mine');

  const mine = useAsync(({ signal }) => hr.myTraining({ signal }), []);
  const certs = useAsync(({ signal }) => hr.myCertifications({ signal }), []);

  const tabs = useMemo(() => {
    const base = [
      { id: 'mine', label: t('My training'), count: mine.data?.counts?.upcoming || undefined },
      { id: 'certs', label: t('My certifications'), count: certs.data?.counts?.expiring || undefined },
    ];
    if (isHr) {
      base.push({ id: 'calendar', label: t('Calendar') });
      base.push({ id: 'matrix', label: t('Certification matrix') });
    }
    return base;
  }, [mine.data, certs.data, isHr]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t('Training')}</h1>
        <p className="page-head__sub">{t('Courses you are booked on, and the qualifications you hold')}</p>
      </div>

      <Tabs items={tabs} value={tab} onChange={setTab} />

      {tab === 'mine' && <MyTraining state={mine} />}
      {tab === 'certs' && <MyCertifications state={certs} />}
      {tab === 'calendar' && isHr && <Calendar />}
      {tab === 'matrix' && isHr && <Matrix />}
    </div>
  );
}

/* ------------------------------------------------------------- Employee */

function MyTraining({ state }) {
  const [open, setOpen] = useState(null);

  return (
    <Async state={state} rows={4}>
      {(data) => {
        if (data.unavailable) {
          return (
            <Card>
              <EmptyState
                title={t('Training is not set up')}
                body={t('This site does not have the HRMS training module available.')}
                icon="◍"
              />
            </Card>
          );
        }
        if (!data.upcoming.length && !data.past.length) {
          return (
            <Card>
              <EmptyState
                title={t('No training booked')}
                body={t('Courses HR books you on will appear here.')}
                icon={<Icon name="checklist" size={22} />}
              />
            </Card>
          );
        }
        return (
          <div className="stack">
            {data.counts.mandatory > 0 && (
              <Card className="card--muted">
                <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <Icon name="checklist" size={18} />
                  <div>
                    <strong>
                      {data.counts.mandatory === 1
                        ? t('1 mandatory course coming up')
                        : t('{0} mandatory courses coming up', [data.counts.mandatory])}
                    </strong>
                    <p className="small subtle" style={{ margin: '2px 0 0' }}>
                      {t('Attendance on these is expected, not optional.')}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {data.upcoming.length > 0 && (
              <EventList label={t('Coming up')} events={data.upcoming} onOpen={setOpen} />
            )}
            {data.past.length > 0 && (
              <EventList label={t('Completed')} events={data.past} onOpen={setOpen} past />
            )}

            <EventDrawer name={open} onClose={() => setOpen(null)} onChanged={state.reload} />
          </div>
        );
      }}
    </Async>
  );
}

function EventList({ label, events, onOpen, past = false }) {
  return (
    <Card flush title={label}>
      <ul className="train-list">
        {events.map((event) => (
          <li key={event.name}>
            <button type="button" className="train-row" onClick={() => onOpen(event.name)}>
              <div className="col" style={{ gap: 3, minWidth: 0 }}>
                <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong className="truncate">{event.event_name}</strong>
                  {event.is_mandatory && <Pill tone="warning">{t('Mandatory')}</Pill>}
                  {past && event.my_attendance === 'Present' && (
                    <Pill tone="success" dot>{t('Attended')}</Pill>
                  )}
                  {past && event.my_attendance === 'Absent' && (
                    <Pill tone="danger" dot>{t('Missed')}</Pill>
                  )}
                  {event.has_certificate && <Pill>{t('Certificate')}</Pill>}
                </span>
                <span className="small subtle truncate">
                  {[whenLabel(event), event.location, event.trainer_name].filter(Boolean).join(' · ')}
                </span>
              </div>
              {event.can_give_feedback && <Pill tone="primary">{t('Feedback due')}</Pill>}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function EventDrawer({ name, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(
    ({ signal }) => (name ? hr.trainingEventDetail(name, { signal }) : Promise.resolve(null)),
    [name],
  );
  const [feedback, setFeedback] = useState('');
  const event = state.data;

  const send = useMutation(async () => {
    if (!feedback.trim()) return toast.error(t('Write your feedback first.'));
    await hr.submitTrainingFeedback(name, feedback);
    toast.success(t('Thank you — feedback sent.'));
    setFeedback('');
    await state.reload();
    onChanged();
  });

  // Only offered where the backend will accept it: attended, not yet given.
  const canGiveFeedback = event
    && event.my_attendance === 'Present'
    && event.my_status !== 'Feedback Submitted';

  return (
    <Drawer
      open={Boolean(name)}
      onClose={onClose}
      title={event?.event_name || t('Training')}
      subtitle={event ? [event.type, event.level].filter(Boolean).join(' · ') : undefined}
    >
      <Async state={state} rows={5}>
        {(data) => (
          <div className="stack">
            <Card className="card--muted">
              <FieldRow label={t('When')} value={whenLabel(data)} />
              <FieldRow label={t('Where')} value={data.location} />
              <FieldRow label={t('Trainer')} value={data.trainer_name} />
              <FieldRow label={t('Programme')} value={data.training_program} />
              <FieldRow label={t('Status')} value={data.event_status ? t(data.event_status) : null} />
              <FieldRow
                label={t('Your attendance')}
                value={data.my_attendance ? t(data.my_attendance) : null}
              />
            </Card>

            {data.introduction && (
              <div>
                <div className="section-heading__label">{t('About this course')}</div>
                <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
                  {data.introduction}
                </p>
              </div>
            )}

            {data.my_status === 'Feedback Submitted' && (
              <Card className="card--muted">
                <span className="row small" style={{ gap: 8, alignItems: 'center' }}>
                  <Pill tone="success" dot>{t('Feedback sent')}</Pill>
                  {t('Thank you.')}
                </span>
              </Card>
            )}

            {canGiveFeedback && (
              <Field label={t('Your feedback')} hint={t('Seen by HR and the trainer.')}>
                <textarea rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
                <Button
                  variant="indigo"
                  size="sm"
                  style={{ marginTop: 'var(--space-2)' }}
                  onClick={send.mutate}
                  disabled={send.pending || !feedback.trim()}
                >
                  {send.pending ? t('Sending…') : t('Send feedback')}
                </Button>
              </Field>
            )}
          </div>
        )}
      </Async>
    </Drawer>
  );
}

function MyCertifications({ state }) {
  return (
    <Async state={state} rows={4}>
      {(data) => (data.certifications.length === 0 ? (
        <Card>
          <EmptyState
            title={t('No certifications on file')}
            body={t('Add them under My profile → Documents so HR has them on record.')}
            icon={<Icon name="shield" size={22} />}
          />
        </Card>
      ) : (
        <div className="stack">
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {data.counts.expired > 0 && <Pill tone="danger">{t('{0} expired', [data.counts.expired])}</Pill>}
            {data.counts.expiring > 0 && <Pill tone="warning">{t('{0} expiring', [data.counts.expiring])}</Pill>}
          </div>
          <Card flush>
            <ul className="train-list">
              {data.certifications.map((row) => (
                <li className={`cert-row cert-row--${row.expiry_state}`} key={row.name}>
                  <div className="col" style={{ gap: 3, minWidth: 0 }}>
                    <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong className="truncate">{row.title || row.document_type}</strong>
                      {row.is_verified
                        ? <Pill tone="success" dot>{t('Verified')}</Pill>
                        : <Pill dot>{t('Awaiting check')}</Pill>}
                    </span>
                    <span className="small subtle truncate">
                      {[t(row.document_type), row.document_number].filter(Boolean).join(' · ')}
                    </span>
                    <span className={`small cert-row__expiry cert-row__expiry--${row.expiry_state}`}>
                      {EXPIRY_LABEL(row)}
                    </span>
                  </div>
                  {row.attachment && (
                    <a className="btn btn--sm" href={row.attachment} target="_blank" rel="noreferrer">
                      <Icon name="external" size={13} /> {t('View')}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}
    </Async>
  );
}

/* ------------------------------------------------------------------- HR */

function Calendar() {
  const toast = useToast();
  const state = useAsync(({ signal }) => hr.trainingCalendar(undefined, { signal }), []);
  const [open, setOpen] = useState(null);

  return (
    <Async state={state} rows={5}>
      {(data) => (data.events.length === 0 ? (
        <Card>
          <EmptyState
            title={t('No training scheduled')}
            body={t('Create a Training Event in the desk and it will appear here.')}
            icon="◍"
          />
        </Card>
      ) : (
        <div className="stack">
          <Card flush>
            <ul className="train-list">
              {data.events.map((event) => (
                <li key={event.name}>
                  <button type="button" className="train-row" onClick={() => setOpen(event)}>
                    <div className="col" style={{ gap: 3, minWidth: 0 }}>
                      <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong className="truncate">{event.event_name}</strong>
                        <Pill tone={event.event_status === 'Completed' ? 'success' : undefined} dot>
                          {t(event.event_status)}
                        </Pill>
                        {event.docstatus === 0 && <Pill tone="warning">{t('Draft')}</Pill>}
                      </span>
                      <span className="small subtle truncate">
                        {[whenLabel(event), event.location,
                          t('{0} booked', [event.attendee_count])].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    {event.present_count > 0 && (
                      <span className="small subtle">
                        {t('{0} of {1} present', [event.present_count, event.attendee_count])}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <RosterDrawer
            event={open}
            onClose={() => setOpen(null)}
            onSaved={() => { setOpen(null); state.reload(); toast.success(t('Attendance recorded.')); }}
          />
        </div>
      ))}
    </Async>
  );
}

function RosterDrawer({ event, onClose, onSaved }) {
  const toast = useToast();
  const [marks, setMarks] = useState({});

  // Attendance can only be recorded once the event is submitted — before that
  // HRMS treats the roster as still being composed.
  const canMark = event?.docstatus === 1;

  const save = useMutation(async () => {
    const records = Object.entries(marks).map(([employee, attendance]) => ({ employee, attendance }));
    if (!records.length) return toast.error(t('Mark at least one attendee.'));
    await hr.markTrainingAttendance(event.name, records);
    setMarks({});
    onSaved();
  });

  return (
    <Drawer
      open={Boolean(event)}
      onClose={() => { setMarks({}); onClose(); }}
      title={event?.event_name || t('Training')}
      subtitle={event ? whenLabel(event) : undefined}
      footer={canMark ? (
        <div className="row row--end" style={{ width: '100%', gap: 'var(--space-2)' }}>
          <Button onClick={() => { setMarks({}); onClose(); }}>{t('Cancel')}</Button>
          <Button variant="indigo" onClick={save.mutate} disabled={save.pending || !Object.keys(marks).length}>
            {save.pending ? t('Saving…') : t('Record attendance')}
          </Button>
        </div>
      ) : undefined}
    >
      {event && (
        <div className="stack">
          <Card className="card--muted">
            <FieldRow label={t('Where')} value={event.location} />
            <FieldRow label={t('Trainer')} value={event.trainer_name} />
            <FieldRow label={t('Programme')} value={event.training_program} />
          </Card>

          {!canMark && (
            <p className="small subtle" style={{ margin: 0 }}>
              {t('Submit this event in the desk before recording attendance.')}
            </p>
          )}

          <div>
            <div className="section-heading__label">{t('Roster')}</div>
            <ul className="train-list">
              {(event.attendees || []).map((person) => {
                const current = marks[person.employee] ?? person.attendance ?? '';
                return (
                  <li className="roster-row" key={person.employee}>
                    <Avatar name={person.employee_name} size="sm" />
                    <div className="col" style={{ gap: 1, minWidth: 0, flex: 1 }}>
                      <span className="truncate">{person.employee_name}</span>
                      <span className="small subtle truncate">
                        {[person.department, person.is_mandatory ? t('Mandatory') : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    {canMark ? (
                      <select
                        value={current}
                        style={{ width: 'auto' }}
                        onChange={(e) => setMarks((m) => ({ ...m, [person.employee]: e.target.value }))}
                      >
                        <option value="">{t('—')}</option>
                        <option value="Present">{t('Present')}</option>
                        <option value="Absent">{t('Absent')}</option>
                      </select>
                    ) : (
                      <Pill>{t(person.status)}</Pill>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Matrix() {
  const state = useAsync(({ signal }) => hr.certificationMatrix(undefined, { signal }), []);

  return (
    <Async state={state} rows={5}>
      {(data) => (
        <div className="stack">
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {data.counts.expired > 0 && <Pill tone="danger">{t('{0} expired', [data.counts.expired])}</Pill>}
            {data.counts.expiring > 0 && <Pill tone="warning">{t('{0} expiring', [data.counts.expiring])}</Pill>}
            <Pill>{t('{0} on file', [data.counts.all])}</Pill>
          </div>

          <Card flush>
            <ul className="train-list">
              {data.employees.map((person) => (
                <li className="matrix-row" key={person.employee}>
                  <div className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0 }}>
                    <Avatar name={person.employee_name} size="sm" />
                    <span className="truncate">{person.employee_name}</span>
                  </div>
                  <div className="matrix-certs">
                    {person.certifications.length === 0 ? (
                      <span className="small subtle">{t('None on file')}</span>
                    ) : (
                      person.certifications.map((cert) => (
                        <Pill key={cert.name} tone={EXPIRY_TONE[cert.expiry_state]}>
                          {cert.title || cert.document_type}
                        </Pill>
                      ))
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Async>
  );
}
