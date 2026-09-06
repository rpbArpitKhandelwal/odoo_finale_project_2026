import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtMoney, fmtDate, fmtDateTime, fmtPct } from '../api';
import ListView from '../components/ListView';
import { Pill, Avatar, Modal, useToast, DropBtn } from '../components/ui';
import { HBars, BarChart } from '../components/charts';
import { useAuth } from '../auth';

/* ============================================================ COMMISSIONS LIST */
export function Commissions() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState('');
  const [settleOpen, setSettleOpen] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (period) params.set('period', period);
    api.get(`/commissions${params.toString() ? `?${params}` : ''}`).then((r) => setData(r)).catch((e) => toast(e.message, 'err'));
  };
  useEffect(() => { load(); }, [status, period]);

  if (!data) return <div className="page-loading">Loading commissions…</div>;
  const rows = data.commissions || [];
  const periods = [...new Set(rows.map((r) => r.period))].sort().reverse();
  const canSettle = ['finance', 'admin'].includes(user?.role);

  const settle = async () => {
    try {
      const r = await api.post('/commissions/settle', period ? { period } : {});
      toast(`Settled ${r.settled} commission(s) — payout ${fmtMoney(r.total)}`, 'ok');
      setSettleOpen(false); load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="kpi-chips">
        <div className="kpi-chip" style={{ background: '#5F6B7A' }}><span className="cnt">{rows.length}</span> Total</div>
        <div className="kpi-chip" style={{ background: '#B3611E' }}><span className="cnt">{fmtMoney(data.sums?.draft)}</span> Draft</div>
        <div className="kpi-chip" style={{ background: '#4C689E' }}><span className="cnt">{fmtMoney(data.sums?.confirmed)}</span> Confirmed</div>
        <div className="kpi-chip" style={{ background: '#7A6DAE' }}><span className="cnt">{fmtMoney(data.sums?.approved)}</span> Approved</div>
        <div className="kpi-chip" style={{ background: '#0F7B3D' }}><span className="cnt">{fmtMoney(data.sums?.paid)}</span> Paid</div>
        <div className="kpi-summary"><div><b>{fmtMoney(data.sums?.total)}</b><span className="up">commission value in view</span></div></div>
      </div>

      <ListView
        rows={rows}
        onRowClick={(r) => nav(`/commissions/${r.id}`)}
        searchKeys={['number', 'salesperson_name', 'quote_number', 'customer_name', 'rule_name', 'status']}
        empty="No commissions — they generate automatically when invoices are fully paid"
        actions={
          <>
            <select className="f" style={{ width: 130 }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="confirmed">Confirmed</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
            </select>
            <select className="f" style={{ width: 120 }} value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">All periods</option>
              {periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <a className="btn" href={`/api/commissions/export?format=csv${period ? `&period=${period}` : ''}`}>⬇ CSV</a>
            <a className="btn" href={`/api/commissions/export?format=xls${period ? `&period=${period}` : ''}`}>⬇ XLS</a>
            <a className="btn" href={`/api/commissions/export?format=pdf${period ? `&period=${period}` : ''}`}>⬇ PDF</a>
            {canSettle && <button className="btn-new" onClick={() => setSettleOpen(true)}>💸 Settle payout</button>}
          </>
        }
        columns={[
          { key: 'number', label: 'Commission', link: true, width: 110 },
          { key: 'period', label: 'Period', width: 90 },
          { key: 'salesperson_name', label: 'Salesperson', render: (r) => <><Avatar name={r.salesperson_name} size={22} />{r.salesperson_name}</> },
          { key: 'sales_team', label: 'Team', width: 95 },
          { key: 'quote_number', label: 'Quotation', width: 100 },
          { key: 'customer_name', label: 'Customer' },
          { key: 'invoice_number', label: 'Invoice', width: 95 },
          { key: 'base_amount', label: 'Invoiced base', num: true, render: (r) => fmtMoney(r.base_amount), width: 110 },
          { key: 'rate', label: 'Rate', num: true, render: (r) => (r.rate_type === 'fixed' ? fmtMoney(r.rate) : `${r.rate}%`), width: 80 },
          { key: 'amount', label: 'Commission', num: true, render: (r) => <b>{fmtMoney(r.amount)}</b>, width: 105 },
          { key: 'status', label: 'Status', render: (r) => <Pill status={r.status} />, width: 105 },
        ]}
      />

      {settleOpen && (
        <Modal title="Settle commissions" onClose={() => setSettleOpen(false)}
          footer={<><button className="btn" onClick={() => setSettleOpen(false)}>Cancel</button><button className="btn success" onClick={settle}>Run payout</button></>}>
          <p style={{ marginTop: 0, fontSize: 13 }}>
            Pays out every <b>approved</b> commission{period ? ` in period ${period}` : ' (all periods)'}.
            Currently approved: <b>{fmtMoney(data.sums?.approved)}</b>.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ============================================================ COMMISSION DETAIL (form view) */
export function CommissionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);

  const load = () => api.get(`/commissions/${id}`).then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [id]);
  if (!data) return <div className="page-loading">Loading commission…</div>;
  const c = data.commission;

  const act = async (action) => {
    try { await api.post(`/commissions/${c.id}/${action}`, {}); toast('Commission updated', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const canConfirm = c.status === 'draft' && (['manager', 'admin', 'finance'].includes(user.role) || c.salesperson_id === user.id);
  const canApprove = c.status === 'confirmed' && ['manager', 'admin'].includes(user.role);
  const canReset = c.status !== 'paid' && c.status !== 'draft' && ['manager', 'admin'].includes(user.role);

  return (
    <>
      <div className="breadcrumbs">Commissions <b>{c.number}</b></div>
      <div className="ctrl-bar">
        <h2 style={{ margin: 0, display: 'flex', gap: 12, alignItems: 'center' }}>{c.number} <Pill status={c.status} /></h2>
        <div style={{ flex: 1 }} />
        {canConfirm && <button className="btn primary" onClick={() => act('confirm')}>✔ Confirm</button>}
        {canApprove && <button className="btn primary" onClick={() => act('approve')}>Approve for settlement</button>}
        {canReset && <button className="btn warning" onClick={() => act('cancel')}>Reset to draft</button>}
      </div>

      <div className="card pad" style={{ margin: '6px 18px' }}>
        <div className="grid3">
          <div>
            <label className="f">Salesperson</label>
            <div style={{ fontSize: 14 }}><Avatar name={c.salesperson_name} size={26} /> <b>{c.salesperson_name}</b> · {c.sales_team}</div>
          </div>
          <div>
            <label className="f">Commission amount</label>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#0F7B3D' }}>{fmtMoney(c.amount)}</div>
          </div>
          <div>
            <label className="f">Period / status</label>
            <div style={{ fontSize: 14 }}>{c.period} · <Pill status={c.status} /></div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12, padding: '0 18px', alignItems: 'start' }}>
        <div className="card pad" style={{ margin: 0 }}>
          <h3>Calculation</h3>
          <table className="list">
            <tbody>
              <tr><td>Quotation</td><td className="link-cell" onClick={() => nav(`/quotations/${c.quotation_id}`)}>{c.quote_number} ({fmtMoney(c.quote_total)})</td></tr>
              <tr><td>Customer</td><td>{c.customer_name}</td></tr>
              <tr><td>Paid invoice</td><td>{c.invoice_number} — <b>{fmtMoney(c.invoice_amount)}</b></td></tr>
              <tr><td>Commissioned base</td><td>{fmtMoney(c.base_amount)}</td></tr>
              <tr><td>Order margin</td><td>{fmtPct(c.margin_pct)} → tier rate <b>{c.rate_type === 'fixed' ? fmtMoney(c.rate) : `${c.rate}%`}</b></td></tr>
              <tr><td>Rule applied</td><td>{c.rule_name}</td></tr>
              <tr><td><b>Commission</b></td><td className="num"><b>{fmtMoney(c.amount)}</b></td></tr>
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            Lifecycle: draft → confirmed (rep verifies) → approved (manager) → paid (finance settlement run).
          </div>
        </div>
        <div className="card pad" style={{ margin: 0 }}>
          <h3>History</h3>
          <div className="timeline">
            <div className="tl-item"><b>Generated</b><div className="when">{fmtDateTime(c.created_at)}</div></div>
            {c.confirmed_at && <div className="tl-item"><b>Confirmed</b><div className="when">{fmtDateTime(c.confirmed_at)}</div></div>}
            {c.approved_at && <div className="tl-item"><b>Approved for settlement</b><div className="when">{fmtDateTime(c.approved_at)}</div></div>}
            {c.paid_at && <div className="tl-item"><b>Paid out</b><div className="when">{fmtDateTime(c.paid_at)}</div></div>}
          </div>
          <h3 style={{ marginTop: 14 }}>Audit</h3>
          {(data.audit || []).map((a) => (
            <div key={a.id} style={{ fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid #EEF0F3' }}>
              <b>{a.action}</b> · {a.details}<div className="when" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{a.user_name} · {fmtDateTime(a.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ height: 18 }} />
    </>
  );
}

/* ============================================================ COMMISSION RULES */
export function CommissionRules() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const canEdit = ['admin', 'manager'].includes(user?.role);

  const load = () => api.get('/commission-rules').then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="page-loading">Loading rules…</div>;

  const del = async (id) => {
    if (!confirm('Delete this commission rule?')) return;
    try { await api.del(`/commission-rules/${id}`); toast('Rule deleted', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const toggleActive = async (r) => {
    try { await api.put(`/commission-rules/${r.id}`, { active: !r.active }); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const scopeLabel = (r) => r.scope === 'all' ? 'Everyone'
    : r.scope === 'salesperson' ? `Salesperson: ${r.salesperson_name}`
    : r.scope === 'team' ? `Team: ${r.team}`
    : r.scope === 'category' ? `Category: ${r.category_name}`
    : `Product: ${r.product_name}`;

  return (
    <>
      <div className="breadcrumbs">Commissions ‣ Configuration <b>Commission Rules</b></div>
      <div className="ctrl-bar">
        <span className="page-title">Most specific matching rule wins: <b>product › category › salesperson › team › everyone</b></span>
        <div style={{ flex: 1 }} />
        {canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New rule</button>}
      </div>
      <ListView
        rows={data.rules}
        searchKeys={['name', 'scope', 'rate_type']}
        columns={[
          { key: 'name', label: 'Rule', link: true },
          { key: 'scope', label: 'Applies to', render: (r) => scopeLabel(r) },
          { key: 'rate_type', label: 'Type', render: (r) => r.rate_type === 'fixed' ? 'Fixed amount' : r.rate_type === 'margin_tier' ? 'Margin-tiered %' : 'Percentage' },
          { key: 'rate', label: 'Rate', num: true, render: (r) => r.rate_type === 'margin_tier' ? <span style={{ color: 'var(--muted)' }}>see tiers →</span> : (r.rate_type === 'fixed' ? fmtMoney(r.rate) : `${r.rate}%`) },
          { key: 'margin_tiers', label: 'Margin tiers', sort: false, render: (r) => {
            if (r.rate_type !== 'margin_tier' || !r.margin_tiers) return '—';
            const tiers = typeof r.margin_tiers === 'string' ? JSON.parse(r.margin_tiers) : r.margin_tiers;
            return <span style={{ fontSize: 12 }}>{tiers.map((t) => `≥${t.min_margin}% → ${t.rate}%`).join(' · ')}</span>;
          } },
          { key: 'active', label: 'Active', render: (r) => <Pill status={r.active ? 'fulfilled' : 'cancelled'} label={r.active ? 'active' : 'archived'} /> },
          ...(canEdit ? [{ key: '_act', label: '', sort: false, render: (r) => (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); toggleActive(r); }}>{r.active ? 'Archive' : 'Activate'}</button>
              <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); del(r.id); }}>Delete</button>
            </span>
          ) }] : []),
        ]}
      />
      {showNew && <RuleModal reps={data.reps} onClose={() => setShowNew(false)} reload={load} />}
    </>
  );
}

function RuleModal({ reps, onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', scope: 'all', rate_type: 'percentage', rate: 3 });
  const [tiers, setTiers] = useState([{ min_margin: 40, rate: 6 }, { min_margin: 30, rate: 4 }, { min_margin: 0, rate: 2 }]);
  const [catalog, setCatalog] = useState({ products: [], categories: [] });

  useEffect(() => {
    api.get('/products').then((r) => setCatalog({ products: r.products, categories: [...new Map(r.products.map((p) => [p.category_id, { id: p.category_id, name: p.category_name }])).values()] }));
  }, []);

  const save = async () => {
    try {
      await api.post('/commission-rules', {
        ...f,
        margin_tiers: f.rate_type === 'margin_tier' ? tiers : null,
      });
      toast('Rule created', 'ok'); reload(); onClose();
    } catch (e) { toast(e.message, 'err'); }
  };
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  return (
    <Modal title="New commission rule" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name} onClick={save}>Create rule</button></>}>
      <div className="grid2">
        <div className="field"><label className="f">Rule name</label><input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Star Rep Bonus" /></div>
        <div className="field"><label className="f">Applies to</label>
          <select className="f" value={f.scope} onChange={(e) => set('scope', e.target.value)}>
            <option value="all">Everyone</option>
            <option value="salesperson">Specific salesperson</option>
            <option value="team">Sales team</option>
            <option value="category">Product category</option>
            <option value="product">Specific product</option>
          </select>
        </div>
      </div>
      {f.scope === 'salesperson' && (
        <div className="field"><label className="f">Salesperson</label>
          <select className="f" onChange={(e) => set('salesperson_id', e.target.value)} defaultValue="">
            <option value="">Select…</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.sales_team})</option>)}
          </select>
        </div>
      )}
      {f.scope === 'team' && (
        <div className="field"><label className="f">Team</label>
          <select className="f" onChange={(e) => set('team', e.target.value)} defaultValue="">
            <option value="">Select…</option>
            {[...new Set(reps.map((r) => r.sales_team))].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      )}
      {f.scope === 'category' && (
        <div className="field"><label className="f">Category</label>
          <select className="f" onChange={(e) => set('category_id', e.target.value)} defaultValue="">
            <option value="">Select…</option>
            {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
      {f.scope === 'product' && (
        <div className="field"><label className="f">Product</label>
          <select className="f" onChange={(e) => set('product_id', e.target.value)} defaultValue="">
            <option value="">Select…</option>
            {catalog.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
          </select>
        </div>
      )}
      <div className="grid2">
        <div className="field"><label className="f">Rate type</label>
          <select className="f" value={f.rate_type} onChange={(e) => set('rate_type', e.target.value)}>
            <option value="percentage">% of invoiced amount</option>
            <option value="fixed">Fixed amount per order</option>
            <option value="margin_tier">Margin-tiered %</option>
          </select>
        </div>
        {f.rate_type !== 'margin_tier' && (
          <div className="field"><label className="f">{f.rate_type === 'fixed' ? 'Amount ($)' : 'Rate (%)'}</label>
            <input className="f" type="number" value={f.rate} onChange={(e) => set('rate', Number(e.target.value))} />
          </div>
        )}
      </div>
      {f.rate_type === 'margin_tier' && (
        <div className="field">
          <label className="f">Margin tiers — order margin ≥ threshold earns that rate</label>
          {tiers.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12.5 }}>margin ≥</span>
              <input className="f" style={{ width: 90 }} type="number" value={t.min_margin} onChange={(e) => setTiers((ts) => ts.map((x, j) => j === i ? { ...x, min_margin: Number(e.target.value) } : x))} />%
              <span style={{ fontSize: 12.5 }}>→ rate</span>
              <input className="f" style={{ width: 90 }} type="number" value={t.rate} onChange={(e) => setTiers((ts) => ts.map((x, j) => j === i ? { ...x, rate: Number(e.target.value) } : x))} />%
              <button className="btn sm danger" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn sm" onClick={() => setTiers((ts) => [...ts, { min_margin: 0, rate: 1 }])}>＋ tier</button>
        </div>
      )}
    </Modal>
  );
}

/* ============================================================ COMMISSIONS REPORT */
export function CommissionReport() {
  const [params] = useSearchParams();
  const [detailMode, setDetailMode] = useState(params.get('view') === 'detail');
  const [agg, setAgg] = useState(null);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const { toast } = useToast();

  const load = () => {
    setErr('');
    api.get('/commissions/report/by-salesperson').then(setAgg).catch((e) => { setErr(e.message); toast(e.message, 'err'); });
    api.get('/commissions/report/detail').then(setDetail).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { setDetailMode(params.get('view') === 'detail'); }, [params]);

  if (err) return <div className="card pad" style={{ margin: 20 }}><h3>Unable to load commissions report</h3><p style={{ color: '#DC2626' }}>{err}</p><button className="btn primary" onClick={load}>Retry</button></div>;
  if (!agg) return <div className="page-loading">Loading report…</div>;
  const byRep = agg.by_salesperson || [];
  const byPeriod = agg.by_period || [];

  return (
    <>
      <div className="breadcrumbs">Reporting <b>Commissions by Salesperson</b></div>
      <div className="ctrl-bar">
        <span className="page-title"><b>{detailMode ? 'Sales Commission Detail' : 'Commissions by Salesperson'}</b></span>
        <div style={{ flex: 1 }} />
        <div className="seg">
          <button className={!detailMode ? 'active' : ''} onClick={() => setDetailMode(false)}>By salesperson</button>
          <button className={detailMode ? 'active' : ''} onClick={() => setDetailMode(true)}>Detail</button>
        </div>
        <a className="btn" href="/api/commissions/export?format=pdf">⬇ PDF</a>
      </div>

      {!detailMode ? (
        <>
          <div className="dash-grid" style={{ paddingTop: 4 }}>
            {byRep.length === 0 && <div className="card pad">No commissions yet.</div>}
            {byRep.map((r) => (
              <div className="kpi-card" key={r.salesperson_id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={r.salesperson_name} size={30} />
                  <div><b>{r.salesperson_name}</b><div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{r.sales_team}</div></div>
                </div>
                <div className="val" style={{ marginTop: 8 }}>{fmtMoney(r.total_commission)}</div>
                <div className="sub">{r.orders} commissioned orders · avg rate {Number(r.avg_rate).toFixed(1)}%</div>
                <div style={{ display: 'flex', gap: 5, marginTop: 8, fontSize: 11 }}>
                  <span className="pill" style={{ background: '#EDEFF2', color: '#5F6B7A' }}>draft {fmtMoney(r.draft)}</span>
                  <span className="pill" style={{ background: '#DCEBF7', color: '#2563EB' }}>conf {fmtMoney(r.confirmed)}</span>
                  <span className="pill" style={{ background: '#FFE8CC', color: '#B3611E' }}>appr {fmtMoney(r.approved)}</span>
                  <span className="pill" style={{ background: '#DFF0D8', color: '#2F7D32' }}>paid {fmtMoney(r.paid)}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 18px' }}>
            <div className="card pad" style={{ margin: 0 }}>
              <h3>Commission by period</h3>
              <BarChart data={byPeriod.map((m) => ({ label: m.period, value: Math.round(m.total) }))} fmt={(v) => fmtMoney(v)} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)' }}>
                {byPeriod.map((m) => <span key={m.period}>{m.period}</span>)}
              </div>
            </div>
            <div className="card pad" style={{ margin: 0 }}>
              <h3>Leaderboard <span className="muted">total commission earned</span></h3>
              <HBars data={byRep.map((r) => ({ label: `${r.salesperson_name} (${r.sales_team})`, value: Math.round(r.total_commission) }))} fmt={(v) => fmtMoney(v)} />
            </div>
          </div>
          <div style={{ height: 18 }} />
        </>
      ) : (
        <ListView
          rows={detail?.detail || []}
          searchKeys={['number', 'salesperson_name', 'quote_number', 'customer_name', 'status', 'period']}
          empty="No commission rows"
          columns={[
            { key: 'number', label: 'Commission', link: true, width: 110 },
            { key: 'period', label: 'Period', width: 90 },
            { key: 'salesperson_name', label: 'Salesperson', render: (r) => <><Avatar name={r.salesperson_name} size={22} />{r.salesperson_name}</> },
            { key: 'quote_number', label: 'Quotation', width: 100 },
            { key: 'customer_name', label: 'Customer' },
            { key: 'base_amount', label: 'Base', num: true, render: (r) => fmtMoney(r.base_amount) },
            { key: 'margin_pct', label: 'Margin', num: true, render: (r) => fmtPct(r.margin_pct) },
            { key: 'rate', label: 'Rate', num: true, render: (r) => (r.rate_type === 'fixed' ? fmtMoney(r.rate) : `${r.rate}%`) },
            { key: 'amount', label: 'Commission', num: true, render: (r) => <b>{fmtMoney(r.amount)}</b> },
            { key: 'status', label: 'Status', render: (r) => <Pill status={r.status} /> },
          ]}
        />
      )}
    </>
  );
}
