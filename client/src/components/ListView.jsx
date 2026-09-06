import React, { useMemo, useState } from 'react';

/* Odoo-style list view: checkbox column, sortable headers, search, pagination, row click */
export default function ListView({
  columns, rows, onRowClick, searchKeys = [], rowsPerPage = 15, empty = 'No records found',
  actions, toolbar, selectable = false, selectedIds, onSelectionChange,
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null); // { key, dir }
  const [page, setPage] = useState(0);
  const [checked, setChecked] = useState({});

  const filtered = useMemo(() => {
    let out = rows;
    if (q && searchKeys.length) {
      const needle = q.toLowerCase();
      out = out.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(needle)));
    }
    if (sort) {
      const { key, dir } = sort;
      out = [...out].sort((a, b) => {
        const av = a[key], bv = b[key];
        const an = typeof av === 'number' ? av : parseFloat(av);
        const bn = typeof bv === 'number' ? bv : parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
    }
    return out;
  }, [rows, q, sort, searchKeys]);

  const pages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const cur = Math.min(page, pages - 1);
  const view = filtered.slice(cur * rowsPerPage, cur * rowsPerPage + rowsPerPage);

  const toggleSort = (key) => setSort((s) => (s && s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const allChecked = view.length > 0 && view.every((r) => checked[r.id]);
  const toggleAll = () => {
    const next = { ...checked };
    view.forEach((r) => { next[r.id] = !allChecked; });
    setChecked(next);
    onSelectionChange && onSelectionChange(Object.keys(next).filter((k) => next[k]).map(Number));
  };
  const toggleOne = (id) => {
    const next = { ...checked, [id]: !checked[id] };
    setChecked(next);
    onSelectionChange && onSelectionChange(Object.keys(next).filter((k) => next[k]).map(Number));
  };

  return (
    <div className="card">
      <div className="ctrl-bar">
        {toolbar || (
          <>
            <div className="ctrl-search">
              <span className="ico">🔍</span>
              <input placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
              {q && <span className="clear" onClick={() => setQ('')}>✕</span>}
            </div>
            <div className="ctrl-right">
              {actions}
              <div className="pager">
                <span>{filtered.length} records</span>
                <button disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹</button>
                <span>{cur + 1}/{pages}</span>
                <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>›</button>
              </div>
            </div>
          </>
        )}
      </div>
      <table className="list">
        <thead>
          <tr>
            {selectable && <th style={{ width: 34 }}><input type="checkbox" className="row-check" checked={!!allChecked} onChange={toggleAll} /></th>}
            {columns.map((c) => (
              <th key={c.key} className={`${c.num ? 'num' : ''} ${c.sort === false ? 'no-sort' : ''}`}
                style={c.width ? { width: c.width } : undefined}
                onClick={() => c.sort !== false && toggleSort(c.key)}>
                {c.label}
                {sort && sort.key === c.key && <span className="sort-ind">{sort.dir > 0 ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.map((r, i) => (
            <tr key={r.id ?? i} onClick={() => onRowClick && onRowClick(r)} style={{ cursor: onRowClick ? 'pointer' : 'default' }}>
              {selectable && (
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" className="row-check" checked={!!checked[r.id]} onChange={() => toggleOne(r.id)} />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.key} className={`${c.num ? 'num' : ''} ${c.link ? 'link-cell' : ''}`}>
                  {c.render ? c.render(r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
          {view.length === 0 && (
            <tr><td colSpan={columns.length + (selectable ? 1 : 0)}><div className="empty-state"><div className="big">🗒️</div>{empty}</div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
