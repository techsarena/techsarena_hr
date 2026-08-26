/**
 * Org chart — who reports to whom.
 *
 * Drawn as an indented tree rather than the classic boxes-and-connectors
 * layout: a wide chart forces horizontal scrolling on every screen narrower
 * than the org, and a deep one becomes unreadable. Indentation costs one line
 * per person regardless of depth, and collapses naturally.
 *
 * The server sends flat nodes with parent pointers; the tree is assembled here
 * because the client is what needs to look nodes up to expand and focus them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Avatar, Button, Card, EmptyState, SearchInput } from '../components/ui';
import { Icon } from '../components/Icon';

/** Nests the flat node list, keeping the server's name ordering. */
function buildTree(nodes, roots) {
  const byId = new Map(nodes.map((node) => [node.id, { ...node, children: [] }]));
  for (const node of byId.values()) {
    if (node.parent && byId.has(node.parent)) byId.get(node.parent).children.push(node);
  }
  return roots.map((id) => byId.get(id)).filter(Boolean);
}

/** Ids on the path from a root down to `target`, so a match can be revealed. */
function pathTo(nodes, target) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path = [];
  let current = byId.get(target)?.parent;
  while (current && byId.has(current)) {
    path.push(current);
    current = byId.get(current).parent;
  }
  return path;
}

export default function OrgChart() {
  const [focus, setFocus] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const state = useAsync(({ signal }) => hr.orgChart(focus, { signal }), [focus]);
  const data = state.data;

  // Everything starts open: these trees are small, and a chart that opens
  // collapsed hides the very thing the screen exists to show.
  useEffect(() => {
    if (data?.nodes) setExpanded(new Set(data.nodes.map((n) => n.id)));
  }, [data]);

  const tree = useMemo(
    () => (data ? buildTree(data.nodes, data.roots) : []),
    [data],
  );

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term || !data) return null;
    return new Set(
      data.nodes
        .filter((n) => `${n.name} ${n.designation || ''}`.toLowerCase().includes(term))
        .map((n) => n.id),
    );
  }, [query, data]);

  // Searching reveals every match by opening its ancestors.
  useEffect(() => {
    if (!matches || !data) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of matches) for (const ancestor of pathTo(data.nodes, id)) next.add(ancestor);
      return next;
    });
  }, [matches, data]);

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Org chart</h1>
          <p className="page-head__sub">Who reports to whom</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Find someone…" />
          {focus && (
            <Button size="sm" onClick={() => { setFocus(null); setQuery(''); }}>
              <Icon name="close" size={13} /> Clear focus
            </Button>
          )}
        </div>
      </div>

      <Async state={state} rows={6}>
        {(chart) => {
          if (chart.total === 0) {
            return (
              <Card>
                <EmptyState
                  title="Nobody to show"
                  body="You do not have anyone reporting to you yet."
                  icon={<Icon name="people" size={22} />}
                />
              </Card>
            );
          }

          return (
            <div className="stack">
              {/* A site that has never filled in `reports_to` renders as a flat
                  list of everyone. Say so, rather than letting it look broken. */}
              {!chart.has_hierarchy && (
                <Card className="card--muted">
                  <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                    <Icon name="people" size={18} />
                    <div>
                      <strong>No reporting lines are set yet</strong>
                      <p className="small subtle" style={{ margin: '2px 0 0' }}>
                        All {chart.total} people are shown flat because nobody has a manager
                        recorded. Set “Reports To” on each employee record and the hierarchy
                        will appear here.
                      </p>
                    </div>
                  </div>
                </Card>
              )}

              {matches && matches.size === 0 && (
                <Card><EmptyState title="No matches" body={`Nobody matches “${query.trim()}”.`} icon="◍" /></Card>
              )}

              <Card flush>
                <ul className="org-tree">
                  {tree.map((node) => (
                    <OrgNode
                      key={node.id}
                      node={node}
                      depth={0}
                      expanded={expanded}
                      matches={matches}
                      onToggle={toggle}
                      onFocus={setFocus}
                      onOpen={(id) => navigate(`/people/${id}`)}
                    />
                  ))}
                </ul>
              </Card>
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function OrgNode({ node, depth, expanded, matches, onToggle, onFocus, onOpen }) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isMatch = matches?.has(node.id);
  // While searching, a branch with no match anywhere inside it is just noise.
  const subtreeHasMatch = useMemo(() => {
    if (!matches) return true;
    const stack = [node];
    while (stack.length) {
      const current = stack.pop();
      if (matches.has(current.id)) return true;
      stack.push(...current.children);
    }
    return false;
  }, [matches, node]);

  if (!subtreeHasMatch) return null;

  return (
    <li className="org-node">
      <div
        className={`org-row${node.is_self ? ' is-self' : ''}${isMatch ? ' is-match' : ''}`}
        style={{ paddingLeft: `calc(var(--space-4) + ${depth * 22}px)` }}
      >
        <button
          type="button"
          className={`org-twisty${hasChildren ? '' : ' is-leaf'}`}
          onClick={() => hasChildren && onToggle(node.id)}
          aria-label={hasChildren ? (isOpen ? 'Collapse' : 'Expand') : undefined}
          aria-expanded={hasChildren ? isOpen : undefined}
          disabled={!hasChildren}
        >
          {hasChildren ? (isOpen ? '▾' : '▸') : ''}
        </button>

        <Avatar name={node.name} src={node.image} size="sm" />

        <button type="button" className="org-main" onClick={() => onOpen(node.id)}>
          <span className="org-name truncate">
            {node.name}
            {node.is_self && <span className="org-you">You</span>}
          </span>
          <span className="org-meta truncate">
            {[node.designation, node.department].filter(Boolean).join(' · ')}
          </span>
        </button>

        <div className="org-actions">
          {node.report_count > 0 && (
            <span className="org-count" title={`${node.report_count} direct reports`}>
              {node.report_count}
            </span>
          )}
          {node.report_count > 0 && (
            <Button size="sm" onClick={() => onFocus(node.id)}>Focus</Button>
          )}
        </div>
      </div>

      {hasChildren && isOpen && (
        <ul className="org-children">
          {node.children.map((child) => (
            <OrgNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              matches={matches}
              onToggle={onToggle}
              onFocus={onFocus}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
