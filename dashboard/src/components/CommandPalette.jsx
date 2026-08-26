/**
 * Command palette — ⌘K / Ctrl-K, or the topbar search box.
 *
 * Two sources, deliberately kept apart:
 *   * **Navigation** is answered locally from the nav model, so moving around
 *     the app never waits on a round-trip and works with the network down.
 *   * **Records** come from `global_search`, which is where every permission
 *     decision is made. This component renders what it is given and filters
 *     nothing itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import hr from '../api/hr';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { visibleGroups } from '../layout/nav';
import { Avatar } from './ui';
import { Icon } from './Icon';

/** Server-side minimum, mirrored so we don't fire a request that returns []. */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 180;

const KIND_ICON = {
  person: 'people',
  document: 'checklist',
  claim: 'receipt',
  leave: 'calendar',
  announcement: 'megaphone',
  action: 'external',
};

/** Flattens the nav model into go-to actions this user can actually reach. */
function navActions(capabilities) {
  const out = [];
  for (const group of visibleGroups(capabilities)) {
    for (const item of group.items) {
      out.push({ id: item.to, kind: 'action', title: item.label, to: item.to, icon: item.icon });
      for (const child of item.children || []) {
        // "Leave · Team calendar" reads better in a flat list than "Team calendar".
        out.push({
          id: child.to,
          kind: 'action',
          title: `${item.label} · ${child.label}`,
          to: child.to,
          icon: item.icon,
        });
      }
    }
  }
  // Two nav entries can point at the same path (a parent and its first child).
  return out.filter((item, i, all) => all.findIndex((x) => x.id === item.id) === i);
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { capabilities } = useWorkspace();
  const [query, setQuery] = useState('');
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const actions = useMemo(() => navActions(capabilities), [capabilities]);

  const matchedActions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return actions.slice(0, 6);
    return actions.filter((a) => a.title.toLowerCase().includes(term)).slice(0, 6);
  }, [actions, query]);

  // Records lag the keystroke; navigation does not. Grouped here so the
  // keyboard cursor runs over one flat list in the order shown.
  const groups = useMemo(() => {
    const out = [];
    if (matchedActions.length) out.push({ key: 'actions', label: 'Go to', results: matchedActions });
    for (const section of sections) out.push(section);
    return out;
  }, [matchedActions, sections]);

  const flat = useMemo(() => groups.flatMap((g) => g.results), [groups]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSections([]);
      setActive(0);
      // Focus after paint, or the browser drops it on a just-mounted node.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced fetch. An AbortController per keystroke means a slow early
  // response cannot overwrite a fast later one.
  useEffect(() => {
    if (!open) return undefined;
    const term = query.trim();
    if (term.length < MIN_CHARS) {
      setSections([]);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      hr.globalSearch(term, { signal: controller.signal })
        .then((data) => { setSections(data.sections || []); setLoading(false); })
        .catch((error) => { if (error.name !== 'AbortError') { setSections([]); setLoading(false); } });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open]);

  // A shrinking result list must not leave the cursor past the end.
  useEffect(() => {
    setActive((prev) => (prev >= flat.length ? Math.max(0, flat.length - 1) : prev));
  }, [flat.length]);

  const choose = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      navigate(item.to);
    },
    [navigate, onClose],
  );

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(flat[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  // Keep the highlighted row in view when the cursor is driven by the keyboard.
  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const term = query.trim();
  const showEmpty = term.length >= MIN_CHARS && !loading && flat.length === 0;
  let cursor = -1;

  return (
    <>
      <div className="scrim no-print" onClick={onClose} />
      <div className="palette no-print" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette__input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search people, leave, expenses, documents…"
            aria-label="Search"
            autoComplete="off"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="palette-results"
          />
          {loading && <span className="palette__spinner" aria-hidden="true" />}
          <kbd>esc</kbd>
        </div>

        <div className="palette__results" id="palette-results" role="listbox" ref={listRef}>
          {groups.map((group) => (
            <div className="palette__group" key={group.key}>
              <div className="palette__label">{group.label}</div>
              {group.results.map((item) => {
                cursor += 1;
                const index = cursor;
                const isActive = index === active;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    key={`${group.key}-${item.id}`}
                    className={`palette__row${isActive ? ' is-active' : ''}`}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(item)}
                  >
                    {item.kind === 'person' ? (
                      <Avatar name={item.title} src={item.image} size="sm" />
                    ) : (
                      <span className="palette__icon">
                        <Icon name={item.icon || KIND_ICON[item.kind] || 'search'} size={15} />
                      </span>
                    )}
                    <span className="palette__text">
                      <span className="palette__title truncate">{item.title}</span>
                      {item.subtitle && <span className="palette__sub truncate">{item.subtitle}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {showEmpty && (
            <div className="palette__empty">
              <div className="state__title">No matches</div>
              <p className="state__body">Nothing you can see matches “{term}”.</p>
            </div>
          )}

          {term.length > 0 && term.length < MIN_CHARS && (
            <p className="palette__hint">Keep typing to search records…</p>
          )}
        </div>

        <footer className="palette__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>↵</kbd> to open</span>
        </footer>
      </div>
    </>
  );
}
