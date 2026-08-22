import { useMemo, useState } from 'react';
import { EmptyState } from './ui';

/**
 * Dense data grid on real <table> markup.
 *
 * This is the reason the HR surface is React rather than a canvas renderer:
 * cell text selects, Ctrl+F finds it, links inside cells get the browser's own
 * context menu, and the header is a real sticky <th>. Sorting and filtering are
 * client-side over an already-fetched page — the endpoints return bounded sets.
 *
 * columns: [{ key, header, render?, sortValue?, align?, width?, sortable? }]
 */
export function DataTable({
  columns,
  rows,
  rowKey = (row, i) => row.name ?? row.id ?? i,
  onRowClick,
  selectedKeys,
  onToggleRow,
  onToggleAll,
  emptyTitle = 'No records',
  emptyBody,
  initialSort,
  maxHeight,
  footer,
}) {
  const [sort, setSort] = useState(initialSort || null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return rows;
    const pick = column.sortValue || ((row) => row[column.key]);
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Sort a copy: the caller's array may be memoised upstream.
    return [...rows].sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      if (av === bv) return 0;
      // Unset sorts last in either direction — an absent value is not a low one.
      if (av === null || av === undefined || av === '') return 1;
      if (bv === null || bv === undefined || bv === '') return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, sort, columns]);

  const toggleSort = (column) => {
    if (column.sortable === false) return;
    setSort((prev) =>
      prev?.key === column.key
        ? { key: column.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key: column.key, dir: 'asc' },
    );
  };

  const selectable = Boolean(onToggleRow);
  const allSelected = selectable && sorted.length > 0 && sorted.every((row, i) => selectedKeys?.has(rowKey(row, i)));

  if (!rows.length) {
    return <EmptyState title={emptyTitle} body={emptyBody} icon="▦" />;
  }

  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="table">
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={allSelected}
                  onChange={() => onToggleAll?.(!allSelected, sorted)}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width, textAlign: column.align }}
                className={column.sortable === false ? '' : 'is-sortable'}
                onClick={() => toggleSort(column)}
                aria-sort={sort?.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                {column.header}
                {sort?.key === column.key && <span className="sort-ind">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => {
            const key = rowKey(row, index);
            const isSelected = selectedKeys?.has(key);
            return (
              <tr
                key={key}
                className={isSelected ? 'is-selected' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {selectable && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={Boolean(isSelected)}
                      onChange={() => onToggleRow(key, row)}
                      aria-label="Select row"
                    />
                  </td>
                )}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.align === 'right' ? 'num' : undefined}
                    style={column.align && column.align !== 'right' ? { textAlign: column.align } : undefined}
                  >
                    {column.render ? column.render(row) : (row[column.key] ?? '—')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

/** Builds a CSV from the same columns the table renders and hands it to the
 *  browser's own download. Uses `exportValue` where a cell renders JSX. */
export function exportCsv(filename, columns, rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.header)).join(',');
  const body = rows
    .map((row) =>
      columns
        .map((column) => {
          const value = column.exportValue
            ? column.exportValue(row)
            : column.sortValue
              ? column.sortValue(row)
              : row[column.key];
          return escape(value);
        })
        .join(','),
    )
    .join('\n');

  const blob = new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
