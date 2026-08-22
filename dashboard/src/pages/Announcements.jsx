import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Card, EmptyState, Pill } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtRelative } from '../api/format';

export default function Announcements() {
  const state = useAsync(({ signal }) => hr.announcements({ signal }), []);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">Announcements</h1>
        <p className="page-head__sub">Published notices aimed at you</p>
      </div>

      <Async state={state} rows={4}>
        {(data) => {
          const items = data.announcements || data.items || (Array.isArray(data) ? data : []);
          if (!items.length) {
            return (
              <Card>
                <EmptyState
                  title="No announcements"
                  body="Notices published for your company or department will appear here."
                  icon={<Icon name="megaphone" size={22} />}
                />
              </Card>
            );
          }
          return (
            <div className="stack">
              {items.map((item, index) => (
                <Card key={item.name || index}>
                  <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
                    <div className="truncate">
                      <h3 className="card__title truncate">{item.title || item.subject || 'Announcement'}</h3>
                      <p className="card__sub">
                        {[item.author || item.owner, item.posted_on || item.creation ? fmtRelative(item.posted_on || item.creation) : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    {item.category && <Pill>{item.category}</Pill>}
                  </div>
                  {item.body || item.message || item.content ? (
                    <div
                      className="muted"
                      style={{ marginTop: 'var(--space-4)', fontSize: 13.5, lineHeight: 1.6 }}
                      // Announcement bodies are authored in the desk's own rich-text
                      // editor and rendered as Frappe renders them.
                      dangerouslySetInnerHTML={{ __html: item.body || item.message || item.content }}
                    />
                  ) : null}
                  {(item.valid_till || item.expires_on) && (
                    <p className="small subtle" style={{ marginTop: 'var(--space-4)' }}>
                      Valid until {fmtDate(item.valid_till || item.expires_on)}
                    </p>
                  )}
                </Card>
              ))}
            </div>
          );
        }}
      </Async>
    </div>
  );
}
