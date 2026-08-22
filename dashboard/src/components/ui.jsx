import { useEffect } from 'react';
import { initials, statusTone } from '../api/format';

/* ---------------- Card ---------------- */
export function Card({ title, subtitle, action, children, flush = false, className = '', ...rest }) {
  return (
    <section className={`card${flush ? ' card--flush' : ''} ${className}`} {...rest}>
      {(title || action) && (
        <header className={`card__head${flush ? ' card__head--flush' : ''}`}>
          <div>
            {title && <h3 className="card__title">{title}</h3>}
            {subtitle && <p className="card__sub">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function SectionHeading({ label, title, subtitle, action }) {
  return (
    <div className="row row--between section-heading">
      <div>
        {label && <div className="section-heading__label">{label}</div>}
        {title && <h2 className="section-heading__title">{title}</h2>}
        {subtitle && <p className="section-heading__sub">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------------- Pill ---------------- */
export function Pill({ children, tone, dot = false }) {
  const resolved = tone || statusTone(children);
  return (
    <span className={`pill${resolved && resolved !== 'default' ? ` pill--${resolved}` : ''}`}>
      {dot && <span className="pill__dot" />}
      {children}
    </span>
  );
}

/* ---------------- Avatar ---------------- */
export function Avatar({ name, src, size = '' }) {
  return (
    <span className={`avatar${size ? ` avatar--${size}` : ''}`} title={name || undefined}>
      {src ? <img src={src} alt="" loading="lazy" /> : initials(name)}
    </span>
  );
}

/* ---------------- Buttons ---------------- */
export function Button({ variant = 'ghost', size, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}${size ? ` btn--${size}` : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------- Stat tile ---------------- */
export function Stat({ label, value, meta, tone }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</span>
      {meta && <span className="stat__meta">{meta}</span>}
    </div>
  );
}

export function StatCard(props) {
  return (
    <div className="card">
      <Stat {...props} />
    </div>
  );
}

/* ---------------- Meter ---------------- */
export function Meter({ value, total, tone }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  return (
    <div className="meter">
      <div className={`meter__fill${tone ? ` meter__fill--${tone}` : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ---------------- States ---------------- */
export function EmptyState({ title = 'Nothing here yet', body, icon = '◍', action }) {
  return (
    <div className="state">
      <div className="state__icon" aria-hidden>{icon}</div>
      <div className="state__title">{title}</div>
      {body && <p className="state__body">{body}</p>}
      {action && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }) {
  return (
    <div className="state state--error">
      <div className="state__icon" aria-hidden>!</div>
      <div className="state__title">{title}</div>
      <p className="state__body">{error?.message || 'An unexpected error occurred.'}</p>
      {onRetry && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

export function Skeleton({ rows = 4 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton skeleton--row" style={{ width: `${100 - i * 6}%` }} />
      ))}
    </div>
  );
}

/**
 * Renders the right thing for a {data, error, loading} triple so every screen
 * treats loading and failure identically.
 */
export function Async({ state, children, empty, rows = 5, onRetry }) {
  if (state.loading && !state.data) return <Skeleton rows={rows} />;
  if (state.error) return <ErrorState error={state.error} onRetry={onRetry || state.reload} />;
  if (!state.data) return empty ?? <EmptyState />;
  return children(state.data);
}

/* ---------------- Tabs ---------------- */
export function Tabs({ items, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className={`tab${value === item.id ? ' is-active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && item.count !== null && <span className="tab__count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Drawer ---------------- */
export function Drawer({ open, onClose, title, subtitle, footer, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim no-print" onClick={onClose} />
      <aside className="drawer no-print" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer__head">
          <div>
            <h2 className="card__title">{title}</h2>
            {subtitle && <p className="card__sub">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer && <footer className="drawer__foot">{footer}</footer>}
      </aside>
    </>
  );
}

export function Modal({ open, onClose, title, subtitle, footer, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim no-print" onClick={onClose} />
      <div className="modal no-print" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer__head">
          <div>
            <h2 className="card__title">{title}</h2>
            {subtitle && <p className="card__sub">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">✕</Button>
        </header>
        <div className="drawer__body">{children}</div>
        {footer && <footer className="drawer__foot">{footer}</footer>}
      </div>
    </>
  );
}

/* ---------------- Field row ----------------
   Unset fields are omitted, never rendered as a placeholder that could be
   mistaken for real data. */
export function FieldRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="field-row">
      <span className="field-row__label">{label}</span>
      <span className="field-row__value">{value}</span>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return (
    <div>
      <label>{label}</label>
      {children}
      {hint && <p className="small subtle" style={{ marginTop: 4 }}>{hint}</p>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="search-input">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" strokeLinecap="round" />
      </svg>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type="search" />
    </div>
  );
}
