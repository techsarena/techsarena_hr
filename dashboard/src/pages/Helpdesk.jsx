/**
 * HR helpdesk — routine questions for HR.
 *
 * Deliberately not the grievance workflow: a grievance names a party it is
 * against and carries a formal process, while "my payslip is short" is a query.
 * Mixing them mis-records the questions and buries the real grievances.
 *
 * One screen serves both sides. An employee sees their own requests; HR gets
 * the queue with filters, assignment and internal notes. The split is driven by
 * capability, not a separate route, so a ticket has one URL for everyone.
 */
import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { t } from '../api/i18n';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useAsync, useMutation } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, EmptyState, Field, Pill, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDateShort, fmtRelative } from '../api/format';

const STATUS_TONE = {
  Open: 'warning',
  'In Progress': 'info',
  'Waiting on Employee': 'primary',
  Resolved: 'success',
  Closed: 'default',
};

const PRIORITY_TONE = { Urgent: 'danger', High: 'warning' };

export default function Helpdesk() {
  const { capabilities } = useWorkspace();
  const isHr = Boolean(capabilities.can_manage_hr);
  const [selected, setSelected] = useState(null);
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState('open');

  // HR reads the whole queue; everyone else reads their own. Two endpoints so
  // the server decides scope rather than the client filtering after the fact.
  const state = useAsync(
    ({ signal }) => (isHr ? hr.ticketQueue(undefined, { signal }) : hr.myTickets(undefined, { signal })),
    [isHr],
  );

  // Derived from state.data, not re-created inline: a fresh [] every render
  // would make the memos below recompute on every render anyway.
  const tickets = useMemo(() => state.data?.tickets || [], [state.data]);
  const counts = useMemo(() => state.data?.counts || {}, [state.data]);

  const visible = useMemo(() => {
    if (filter === 'all') return tickets;
    if (filter === 'closed') return tickets.filter((x) => x.status === 'Resolved' || x.status === 'Closed');
    if (filter === 'unassigned') return tickets.filter((x) => !x.assigned_to && x.status !== 'Resolved' && x.status !== 'Closed');
    return tickets.filter((x) => x.status !== 'Resolved' && x.status !== 'Closed');
  }, [tickets, filter]);

  const tabs = useMemo(() => {
    const base = [
      { id: 'open', label: t('Open'), count: counts.open ?? undefined },
      { id: 'closed', label: t('Closed'), count: counts.closed ?? undefined },
      { id: 'all', label: t('All'), count: counts.all ?? undefined },
    ];
    if (isHr) base.splice(1, 0, { id: 'unassigned', label: t('Unassigned'), count: counts.unassigned ?? undefined });
    return base;
  }, [counts, isHr]);

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">{isHr ? t('Helpdesk') : t('Help & requests')}</h1>
          <p className="page-head__sub">
            {isHr ? t('Questions employees have asked HR') : t('Ask HR a question and track the answer')}
          </p>
        </div>
        <Button variant="indigo" onClick={() => setComposing(true)}>
          <Icon name="plus" size={15} /> {t('New request')}
        </Button>
      </div>

      <Tabs items={tabs} value={filter} onChange={setFilter} />

      <Async state={state} rows={5}>
        {() => (visible.length === 0 ? (
          <Card>
            <EmptyState
              title={t('Nothing here')}
              body={isHr ? t('No tickets match this filter.') : t('Questions you send HR will show here with their answers.')}
              icon={<Icon name="inbox" size={22} />}
            />
          </Card>
        ) : (
          <Card flush>
            <ul className="ticket-list">
              {visible.map((ticket) => (
                <li key={ticket.name}>
                  <button type="button" className="ticket-row" onClick={() => setSelected(ticket.name)}>
                    <div className="col" style={{ gap: 3, minWidth: 0 }}>
                      <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong className="truncate">{ticket.subject}</strong>
                        <Pill tone={STATUS_TONE[ticket.status]} dot>{t(ticket.status)}</Pill>
                        {PRIORITY_TONE[ticket.priority] && (
                          <Pill tone={PRIORITY_TONE[ticket.priority]}>{t(ticket.priority)}</Pill>
                        )}
                      </span>
                      <span className="small subtle truncate">
                        {[
                          ticket.name,
                          t(ticket.category),
                          isHr ? ticket.raised_by_name : null,
                          ticket.modified ? fmtRelative(ticket.modified) : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    {isHr && (
                      <span className="small subtle ticket-row__agent">
                        {ticket.assigned_to || t('Unassigned')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </Async>

      <ComposeDrawer
        open={composing}
        categories={state.data?.categories || []}
        onClose={() => setComposing(false)}
        onDone={() => { setComposing(false); state.reload(); }}
      />

      <TicketDrawer
        name={selected}
        isHr={isHr}
        onClose={() => setSelected(null)}
        onChanged={state.reload}
      />
    </div>
  );
}

/* ------------------------------------------------------------- Compose */

const MAX_ATTACHMENT_MB = 10;

function ComposeDrawer({ open, categories, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ subject: '', category: '', description: '' });
  const [file, setFile] = useState(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = useMutation(async () => {
    if (!form.subject.trim()) return toast.error(t('Give your request a subject.'));
    if (!form.category) return toast.error(t('Pick a category.'));
    if (!form.description.trim()) return toast.error(t('Describe what you need help with.'));

    let attachment;
    if (file) {
      const uploaded = await hr.uploadFile(file, { isPrivate: true });
      attachment = uploaded.file_url;
    }
    await hr.raiseTicket({ ...form, attachment });
    toast.success(t('Sent to HR.'));
    setForm({ subject: '', category: '', description: '' });
    setFile(null);
    onDone();
  });

  const pick = (event) => {
    const chosen = event.target.files?.[0];
    if (!chosen) return;
    if (chosen.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      toast.error(t('That file is too large.'));
      event.target.value = '';
      return;
    }
    setFile(chosen);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('Ask HR')}
      subtitle={t('For questions and corrections — not formal grievances')}
      footer={
        <div className="row row--end" style={{ width: '100%', gap: 'var(--space-2)' }}>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="indigo" onClick={submit.mutate} disabled={submit.pending}>
            {submit.pending ? t('Sending…') : t('Send request')}
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label={t('Subject')}>
          <input value={form.subject} onChange={(e) => set('subject', e.target.value)} />
        </Field>
        <Field label={t('Category')}>
          <select value={form.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">{t('Choose…')}</option>
            {categories.map((c) => <option key={c} value={c}>{t(c)}</option>)}
          </select>
        </Field>
        <Field label={t('What do you need?')} hint={t('Include dates or amounts if they help.')}>
          <textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label={t('Attachment')} hint={t('Optional — a screenshot or document.')}>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={pick} />
          {file && <p className="small subtle" style={{ marginTop: 4 }}>{file.name}</p>}
        </Field>
      </div>
    </Drawer>
  );
}

/* -------------------------------------------------------------- Detail */

const STATUSES = ['Open', 'In Progress', 'Waiting on Employee', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

function TicketDrawer({ name, isHr, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(
    ({ signal }) => (name ? hr.ticketDetail(name, { signal }) : Promise.resolve(null)),
    [name],
  );
  const agents = useAsync(
    ({ signal }) => (name && isHr ? hr.helpdeskAgents({ signal }) : Promise.resolve(null)),
    [name, isHr],
  );

  const [message, setMessage] = useState('');
  const [internal, setInternal] = useState(false);
  const [resolution, setResolution] = useState('');

  const ticket = state.data;

  const send = useMutation(async () => {
    if (!message.trim()) return;
    await hr.replyToTicket(name, message, internal);
    setMessage('');
    setInternal(false);
    await state.reload();
    onChanged();
  });

  const patch = useMutation(async (changes) => {
    await hr.updateTicket(name, changes);
    await state.reload();
    onChanged();
    toast.success(t('Updated.'));
  });

  const resolve = useMutation(async () => {
    if (!resolution.trim()) return toast.error(t('Say what the resolution was.'));
    await hr.updateTicket(name, { status: 'Resolved', resolution });
    setResolution('');
    await state.reload();
    onChanged();
    toast.success(t('Marked resolved.'));
  });

  return (
    <Drawer
      open={Boolean(name)}
      onClose={onClose}
      title={ticket?.subject || t('Request')}
      subtitle={ticket ? [ticket.name, t(ticket.category)].join(' · ') : undefined}
    >
      <Async state={state} rows={5}>
        {(data) => (
          <div className="stack">
            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Pill tone={STATUS_TONE[data.status]} dot>{t(data.status)}</Pill>
              {data.priority && <Pill tone={PRIORITY_TONE[data.priority]}>{t(data.priority)}</Pill>}
              {data.reopen_count > 0 && (
                <Pill tone="warning">{t('Reopened {0}×', [data.reopen_count])}</Pill>
              )}
            </div>

            <Card className="card--muted">
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{data.description}</p>
              {data.attachment && (
                <a className="row" style={{ gap: 6, marginTop: 'var(--space-3)' }}
                   href={data.attachment} target="_blank" rel="noreferrer">
                  <Icon name="external" size={14} /> <span className="small">{t('View attachment')}</span>
                </a>
              )}
              <p className="small subtle" style={{ marginBottom: 0, marginTop: 'var(--space-3)' }}>
                {[data.raised_by_name, data.opened_on ? fmtDateShort(data.opened_on) : null]
                  .filter(Boolean).join(' · ')}
              </p>
            </Card>

            {/* ---- HR controls ---- */}
            {isHr && (
              <div className="grid grid--2">
                <Field label={t('Status')}>
                  <select value={data.status} disabled={patch.pending}
                          onChange={(e) => patch.mutate({ status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{t(s)}</option>)}
                  </select>
                </Field>
                <Field label={t('Priority')}>
                  <select value={data.priority || 'Normal'} disabled={patch.pending}
                          onChange={(e) => patch.mutate({ priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{t(p)}</option>)}
                  </select>
                </Field>
                <Field label={t('Assigned to')}>
                  <select value={data.assigned_to || ''} disabled={patch.pending}
                          onChange={(e) => patch.mutate({ assigned_to: e.target.value })}>
                    <option value="">{t('Unassigned')}</option>
                    {(agents.data?.agents || []).map((a) => (
                      <option key={a.name} value={a.name}>{a.full_name || a.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}

            {/* ---- Conversation ---- */}
            <div>
              <div className="section-heading__label">{t('Conversation')}</div>
              {data.replies.length === 0 ? (
                <p className="small subtle">{t('No replies yet.')}</p>
              ) : (
                <ul className="ticket-thread">
                  {data.replies.map((reply, i) => (
                    <li className={`ticket-reply${reply.is_internal ? ' is-internal' : ''}`} key={i}>
                      <div className="row row--between" style={{ gap: 'var(--space-2)' }}>
                        <strong className="small">{reply.author_name || reply.author}</strong>
                        <span className="small subtle">
                          {reply.is_internal && <Pill tone="warning">{t('Internal')}</Pill>}
                          {reply.posted_on ? ` ${fmtRelative(reply.posted_on)}` : ''}
                        </span>
                      </div>
                      <p className="small" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{reply.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {data.resolution && (
              <Card title={t('Resolution')}>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{data.resolution}</p>
              </Card>
            )}

            {/* ---- Reply box ---- */}
            {data.is_open && (
              <Field label={t('Reply')}>
                <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
                <div className="row row--between" style={{ marginTop: 'var(--space-2)' }}>
                  {isHr ? (
                    <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={internal} style={{ width: 'auto', margin: 0 }}
                             onChange={(e) => setInternal(e.target.checked)} />
                      {t('Internal note (HR only)')}
                    </label>
                  ) : <span />}
                  <Button variant="indigo" size="sm" onClick={send.mutate}
                          disabled={send.pending || !message.trim()}>
                    {send.pending ? t('Sending…') : t('Send')}
                  </Button>
                </div>
              </Field>
            )}

            {/* ---- Close-out ---- */}
            {isHr && data.is_open && (
              <Field label={t('Resolve')} hint={t('The employee sees this as the answer.')}>
                <textarea rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} />
                <Button variant="indigo" size="sm" style={{ marginTop: 'var(--space-2)' }}
                        onClick={resolve.mutate} disabled={resolve.pending}>
                  {t('Mark resolved')}
                </Button>
              </Field>
            )}

            {!isHr && (
              <div className="row row--end" style={{ gap: 'var(--space-2)' }}>
                {data.is_open ? (
                  <Button size="sm" onClick={() => patch.mutate({ status: 'Closed' })} disabled={patch.pending}>
                    {t('Close this request')}
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => patch.mutate({ status: 'Open' })} disabled={patch.pending}>
                    {t('Reopen')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Async>
    </Drawer>
  );
}
