import React, { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDate, fmtPct } from '../api';
import ListView from '../components/ListView';
import { Pill } from '../components/ui';
import { HBars } from '../components/charts';

export default function Reports() {
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [f, setF] = useState({ from: '', to: '', rep: '', approval: '', category: '', product: '' });
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/reports/sales').then(setData).catch((e) => setErr(e.message));
    api.get('/products').then((r) => setProducts(r.products)).catch(() => {});
    api.get('/quotations').then((r) => {
      const reps = [...new Map(r.quotations.map((q) => [q.rep_id, { id: q.rep_id, name: q.rep_name }])).values()].sort((a, b) => a.name.localeCompare(b.name));
      setUsers(reps);
    }).catch(() => {});
  }, []);

  const run = async () => {
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    try { setData(await api.get(`/reports/sales?${params}`)); setErr(''); } catch (e) { setErr(e.message); }
  };

  const categories = [...new Map(products.map((p) => [p.category_id, { id: p.category_id, name: p.category_name }])).values()];
  const exportUrl = (fmt) => {
    const params = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && params.set(k, v));
    params.set('format', fmt);
    return `/api/reports/export?${params}`;
  };

  return (
    <>
      <div className="breadcrumbs">Reporting <b>Sales</b></div>
      <div className="card pad" style={{ margin: '12px 18px 4px' }}>
        <h3>Filters</h3>
        <div className="grid4" style={{ alignItems: 'end' }}>
          <div className="field"><label className="f">From</label><input className="f" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
          <div className="field"><label className="f">To</label><input className="f" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
          <div className="field"><label className="f">Salesperson</label>
            <select className="f" value={f.rep} onChange={(e) => setF({ ...f, rep: e.target.value })}>
              <option value="">All</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="field"><label className="f">Approval</label>
            <select className="f" value={f.approval} onChange={(e) => setF({ ...f, approval: e.target.value })}>
              <option value="">All</option>
              <option value="none">No approval needed</option>
              <option value="manager">Manager approved</option>
              <option value="pending_manager">Pending manager</option>
              <option value="pending_finance">Pending finance</option>
            </select>
          </div>
        </div>
        <div className="grid3" style={{ alignItems: 'end' }}>
          <div className="field"><label className="f">Category</label>
            <select className="f" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">All</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label className="f">Product</label>
            <select className="f" value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })}>
              <option value="">All</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={run}>Apply filters</button>
            <a className="btn" href={exportUrl('csv')}>⬇ CSV</a>
            <a className="btn" href={exportUrl('xls')}>⬇ XLS</a>
            <a className="btn" href={exportUrl('pdf')}>⬇ PDF</a>
          </div>
        </div>
        {err && <div style={{ color: '#CD3D63', fontSize: 12.5 }}>{err}</div>}
      </div>

      {data && (
        <>
          <div className="dash-grid">
            <div className="kpi-card"><div className="lbl">Orders</div><div className="val">{data.totals.count}</div></div>
            <div className="kpi-card"><div className="lbl">Revenue (USD eq.)</div><div className="val">{fmtMoney(data.totals.revenue)}</div></div>
            <div className="kpi-card"><div className="lbl">Discount given (USD eq.)</div><div className="val" style={{ color: '#B3611E' }}>{fmtMoney(data.totals.discount)}</div></div>
            <div className="kpi-card"><div className="lbl">Avg margin</div><div className="val">{fmtPct(data.totals.margin)}</div></div>
          </div>
          <div className="card pad" style={{ margin: '12px 18px' }}>
            <h3>Revenue by salesperson <span className="muted">USD equivalent</span></h3>
            <HBars data={Object.entries(data.rows.reduce((acc, r) => { acc[r.rep_name] = (acc[r.rep_name] || 0) + (r.total_usd ?? r.total); return acc; }, {}))
              .map(([label, value]) => ({ label, value: Math.round(value) }))} fmt={(v) => fmtMoney(v)} />
          </div>
          <ListView
            rows={data.rows}
            searchKeys={['number', 'customer_name', 'rep_name']}
            columns={[
              { key: 'number', label: 'Quotation', link: true, width: 105 },
              { key: 'customer_name', label: 'Customer' },
              { key: 'rep_name', label: 'Salesperson', width: 130 },
              { key: 'status', label: 'Status', render: (r) => <Pill status={r.status} />, width: 120 },
              { key: 'approval_level', label: 'Approval', width: 100, render: (r) => r.approval_level },
              { key: 'subtotal', label: 'Subtotal', num: true, render: (r) => fmtMoney(r.subtotal, r.currency) },
              { key: 'discount_total', label: 'Discount', num: true, render: (r) => fmtMoney(r.discount_total, r.currency) },
              { key: 'total', label: 'Total', num: true, render: (r) => <b>{fmtMoney(r.total, r.currency)}</b> },
              { key: 'margin_pct', label: 'Margin', num: true, render: (r) => fmtPct(r.margin_pct) },
              { key: 'line_count', label: 'Lines', num: true },
              { key: 'confirmed_at', label: 'Confirmed', render: (r) => fmtDate(r.confirmed_at), width: 105 },
            ]}
          />
        </>
      )}
    </>
  );
}
