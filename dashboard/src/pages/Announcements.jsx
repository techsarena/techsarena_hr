import { useEffect, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Avatar, Button, Card, EmptyState, Pill } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDateShort, isoDate, toDate } from '../api/format';
import { t } from '../api/i18n';

/* Read state is per-person and the API carries none, so it lives in this
   browser. A server-side `read` flag, if one ever lands on the payload, wins
   over the local set. */
const READ_KEY = 'ts.announcements.read';

function loadRead() {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveRead(set) {
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify([...set]));
  } catch {
    /* A browser refusing storage just means unread state resets next visit. */
  }
}

/** Body text with its markup stripped, for the one-line feed summary. */
function excerpt(html, limit = 160) {
  const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** Which icon a category earns, reusing the nav's own vocabulary. */
const CATEGORY_ICON = {
  Holiday: 'calendar',
  Policy: 'ledger',
  Benefits: 'wallet',
  Event: 'people',
  Urgent: 'bell',
  General: 'megaphone',
};

export default function Announcements() {
  const state = useAsync(({ signal }) => hr.announcements({ signal }), []);
  const [read, setRead] = useState(loadRead);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => saveRead(read), [read]);

  const markRead = (name) => setRead((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));

  return (
    <div className="stack">
      <Async state={state} rows={4}>
        {(data) => {
          const items = data.announcements || data.items || (Array.isArray(data) ? data : []);

          // The API sends no read flag or pin, so both are derived: a server
          // value is honoured if present, otherwise read comes from this
          // browser and the pin from an unexpired Urgent notice.
          const rows = items.map((item) => ({
            ...item,
            isRead: item.read !== undefined ? Boolean(item.read) : read.has(item.name),
            isPinned: item.pinned !== undefined
              ? Boolean(item.pinned)
              : item.category === 'Urgent' && (!item.expires_on || item.expires_on >= isoDate(new Date())),
          }));

          const unread = rows.filter((row) => !row.isRead).length;

          // Counts come from the whole set, so a chip always says how many
          // exist rather than how many survived the current filter.
          const counts = rows.reduce((acc, row) => {
            const key = row.category || 'General';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {});
          const categories = Object.keys(counts).sort();

          const needle = query.trim().toLowerCase();
          const visible = rows.filter((row) => {
            if (filter !== 'all' && (row.category || 'General') !== filter) return false;
            if (!needle) return true;
            return `${row.title || ''} ${excerpt(row.body) || ''}`.toLowerCase().includes(needle);
          });

          // The pinned notice leads the page; everything else is the feed.
          const pinned = visible.find((row) => row.isPinned) || null;
          const earlier = visible.filter((row) => row !== pinned);

          return (
            <>
              <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                <div>
                  <h1 className="page-head__title">{t("Announcements")}</h1>
                  <p className="page-head__sub">{t("Published notices aimed at you")}</p>
                </div>
                <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  {unread > 0 && <Pill tone="danger">{unread} unread</Pill>}
                  {searching ? (
                    <input
                      autoFocus
                      className="ann-search"
                      placeholder={t("Search announcements…")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onBlur={() => !query && setSearching(false)}
                    />
                  ) : (
                    <Button onClick={() => setSearching(true)}>
                      <Icon name="search" size={15} /> Search
                    </Button>
                  )}
                  <Button
                    onClick={() => setRead(new Set(rows.map((row) => row.name)))}
                    disabled={!unread}
                  >
                    Mark all read
                  </Button>
                </div>
              </div>

              {items.length === 0 ? (
                <Card>
                  <EmptyState
                    title={t("No announcements")}
                    body={t("Notices published for your company or department will appear here.")}
                    icon={<Icon name="megaphone" size={22} />}
                  />
                </Card>
              ) : (
                <div className="split">
                  <div className="stack">
                    <div className="chips">
                      <button
                        type="button"
                        className={`chip${filter === 'all' ? ' is-active' : ''}`}
                        onClick={() => setFilter('all')}
                      >
                        All <span className="chip__count">{rows.length}</span>
                      </button>
                      {categories.map((category) => (
                        <button
                          type="button"
                          key={category}
                          className={`chip${filter === category ? ' is-active' : ''}`}
                          onClick={() => setFilter(category)}
                        >
                          {category} <span className="chip__count">{counts[category]}</span>
                        </button>
                      ))}
                    </div>

                    {pinned && <PinnedNotice item={pinned} onRead={() => markRead(pinned.name)} />}

                    <Card
                      flush
                      title={t("Earlier")}
                      action={<span className="small subtle">{t("Last 90 days")}</span>}
                    >
                      {earlier.length === 0 ? (
                        <p className="small subtle" style={{ padding: '0 var(--space-5) var(--space-5)' }}>
                          Nothing else matches this filter.
                        </p>
                      ) : (
                        <ul className="ann-feed">
                          {earlier.map((item) => (
                            <FeedRow key={item.name} item={item} onRead={() => markRead(item.name)} />
                          ))}
                        </ul>
                      )}
                      <div className="ann-foot">
                        <span className="small subtle">
                          Showing {visible.length} of {rows.length}
                        </span>
                      </div>
                    </Card>
                  </div>

                  <Rail data={data} />
                </div>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}

/* ---------- The pinned notice ---------- */
function PinnedNotice({ item, onRead }) {
  const attachment = item.attachment || null;
  return (
    <article className={`ann-pinned${item.isRead ? '' : ' is-unread'}`}>
      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
        <div className="ann-pinned__flag">
          <Icon name="bell" size={14} />
          Pinned{item.isRead ? '' : ' · Unread'}
        </div>
        <span className="small subtle">{fmtDateShort(item.published_on)}</span>
      </div>

      <h2 className="ann-pinned__title">{item.title || 'Announcement'}</h2>

      {item.body && (
        <div
          className="ann-pinned__body"
          // Bodies are authored in the desk's rich-text editor and rendered
          // as Frappe renders them.
          dangerouslySetInnerHTML={{ __html: item.body }}
        />
      )}

      <div className="row" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Button variant="indigo" onClick={onRead} disabled={item.isRead}>
          {item.isRead ? 'Read' : 'Mark as read'}
        </Button>
        {attachment && (
          <a className="btn btn--ghost" href={attachment} target="_blank" rel="noreferrer">
            View attachment
          </a>
        )}
      </div>
    </article>
  );
}

/* ---------- One row of the Earlier feed ---------- */
function FeedRow({ item, onRead }) {
  const summary = excerpt(item.body);
  return (
    <li>
      <button
        type="button"
        className={`ann-row${item.isRead ? '' : ' is-unread'}`}
        onClick={onRead}
      >
        <span className="ann-row__icon">
          <Icon name={CATEGORY_ICON[item.category] || 'megaphone'} size={16} />
        </span>
        <span className="ann-row__main">
          <span className="ann-row__head">
            <span className="ann-row__title">{item.title || 'Announcement'}</span>
            {item.category && <Pill>{item.category}</Pill>}
          </span>
          {summary && <span className="ann-row__sub">{summary}</span>}
        </span>
        <span className="ann-row__date small subtle">{fmtDateShort(item.published_on)}</span>
      </button>
    </li>
  );
}

/* ---------- Side rail ----------
   Every section renders only from data the payload actually carries, so a
   backend that never sends it simply shows a shorter rail. */
function Rail({ data }) {
  const holidays = data.holidays || [];
  const joiners = data.new_joiners || [];
  const anniversaries = data.work_anniversaries || [];

  // Weekly offs are not news; only named holidays belong in the rail.
  const upcoming = holidays.filter((row) => !row.weekly_off).slice(0, 5);

  if (!upcoming.length && !joiners.length && !anniversaries.length) return null;

  return (
    <div className="split__rail">
      {upcoming.length > 0 && (
        <Card title={t("Next holidays")}>
          <div className="stack">
            {upcoming.map((row) => (
              <div className="row row--between" key={String(row.holiday_date)}>
                <span className="small truncate">{row.description || 'Holiday'}</span>
                <span className="small subtle tabular">{fmtDateShort(row.holiday_date)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {joiners.length > 0 && (
        <Card title={t("New joiners")}>
          <div className="stack">
            {joiners.slice(0, 5).map((row) => (
              <div className="row" key={row.name} style={{ gap: 'var(--space-3)' }}>
                <Avatar name={row.employee_name} size="sm" />
                <div className="truncate">
                  <div className="small truncate" style={{ fontWeight: 600 }}>{row.employee_name}</div>
                  <div className="small subtle truncate">
                    {[row.department, row.joined_on ? fmtDateShort(row.joined_on) : null]
                      .filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {anniversaries.length > 0 && (
        <Card title={t("Work anniversaries")}>
          <div className="stack">
            {anniversaries.slice(0, 5).map((row) => {
              const joined = toDate(row.joined_on);
              const years = joined ? new Date().getFullYear() - joined.getFullYear() : null;
              return (
                <div className="row row--between" key={row.name}>
                  <span className="small truncate">{row.employee_name}</span>
                  <span className="small subtle tabular">
                    {years ? `${years} years · ` : ''}{fmtDateShort(row.joined_on)}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
