import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney, fmtMoney0, fmtPct, fmtDate } from '../api';
import { Pill, useToast, Avatar } from '../components/ui';
import { HBars, LineChart } from '../components/charts';
import { useAuth } from '../auth';

export default function Dashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const { toast } = useToast();
  const [kpi, setKpi] = useState(null);
  const [err, setErr] = useState('');

  const load = () => api.get('/dashboard').then((r) => setKpi(r.kpi)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card pad">Failed to load dashboard: {err}</div>;
  if (!kpi) return <div className="page-loading">Loading dashboard…</div>;

  const alertAction = async (id, action) => {
    try {
      await api.post(`/alerts/${id}/${action}`, {});
      toast(action === 'nudge' ? 'Rep nudged 🔔' : action === 'escalate' ? 'Escalated to manager ⬆️' : 'Alert dismissed', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const STATUS_KANBAN = ['draft', 'pending_manager', 'pending_finance', 'approved', 'sent', 'negotiating', 'confirmed', 'fulfilling', 'fulfilled', 'rejected', 'returned'];
  const statusMap = Object.fromEntries((kpi.quotes_by_status || []).map((s) => [s.status, s]));
  const toConfirm = (statusMap.pending_manager?.c || 0) + (statusMap.pending_finance?.c || 0);
  const toDeliver = (statusMap.confirmed?.c || 0) + (statusMap.fulfilling?.c || 0);
  const toInvoice = (kpi.open_invoices?.c || 0);

  const monthLabel = (m) => new Date(m + '-02').toLocaleDateString('en-GB', { month: 'short' });
  /* last 6 calendar months, zero-filled, so the trend line is meaningful even with sparse data */
  const monthly = (() => {
    const byM = Object.fromEntries((kpi.monthly || []).map((m) => [m.m, m]));
    const out = [];
    const d = new Date(); d.setDate(1);
    for (let i = 5; i >= 0; i--) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
      out.push({ m: key, v: byM[key]?.v || 0, c: byM[key]?.c || 0 });
    }
    return out;
  })();

  return (
    <>
      <div className="kpi-chips">
        <div className="kpi-chip" style={{ background: '#4C689E' }} onClick={() => nav('/quotations')}><span className="cnt">{toConfirm}</span> To Confirm</div>
        <div className="kpi-chip" style={{ background: '#7A6DAE' }} onClick={() => nav('/orders')}><span className="cnt">{toDeliver}</span> To Deliver</div>
        <div className="kpi-chip" style={{ background: '#B3611E' }} onClick={() => nav('/invoices')}><span className="cnt">{toInvoice}</span> To Invoice</div>
        <div className="kpi-summary">
          <div>
            <b>{fmtMoney0(kpi.paid_value)}</b>
            <span className="up">▲ Collected revenue</span>
          </div>
          <div>
            <b>{fmtMoney0(kpi.recurring_mrr)}<span style={{ fontSize: 11, fontWeight: 500 }}> /mo</span></b>
            <span className="up">▲ Recurring (MRR)</span>
          </div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="kpi-card"><div className="lbl">Pipeline value</div><div className="val">{fmtMoney(kpi.pipeline_value)}</div><div className="sub">open quotations & negotiations · USD eq.</div></div>
        <div className="kpi-card"><div className="lbl">Confirmed value</div><div className="val">{fmtMoney(kpi.confirmed_value)}</div><div className="sub">won orders · USD eq.</div></div>
        <div className="kpi-card"><div className="lbl">Avg discount</div><div className="val">{fmtPct(kpi.avg_discount)}</div><div className="sub">on confirmed orders</div></div>
        <div className="kpi-card"><div className="lbl">Avg margin</div><div className="val">{fmtPct(kpi.avg_margin)}</div><div className="sub">blended across won deals</div></div>
      </div>

      <div className="dash-row2">
        <div className="card pad">
          <h3>Monthly revenue <span className="muted">confirmed orders</span></h3>
          {kpi.monthly?.length
            ? <LineChart series={monthly.map((m) => ({ label: `${monthLabel(m.m)} ${m.m.slice(0, 4)} · ${m.c} order(s)`, value: Math.round(m.v) }))} fmt={(v) => fmtMoney0(v)} height={200} />
            : <div className="empty-state">No confirmed orders yet</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: 11.5, marginTop: 4, padding: '0 2%' }}>
            {monthly.map((m) => <span key={m.m}>{monthLabel(m.m)}</span>)}
          </div>
        </div>
        <div className="card pad">
          <h3>Deal health <span className="muted">{kpi.alerts?.length} open</span></h3>
          {kpi.alerts?.length === 0 && <div className="empty-state" style={{ padding: 20 }}><div className="big">✅</div>All deals healthy</div>}
          {(kpi.alerts || []).slice(0, 5).map((a) => (
            <div className="alert-row" key={a.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/quotations/${a.quotation_id}`)} title="Open the quotation">
              <div className={`alert-ico sev-${a.severity}`}>{a.kind === 'stalled' ? '⏳' : a.kind === 'anomaly' ? '📉' : a.kind === 'backorder' ? '📦' : '🚚'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{a.message}</div>
                <div style={{ color: 'var(--muted)', fontSize: 11 }}>{a.kind.toUpperCase()} · {fmtDate(a.updated_at)} · click to open →</div>
              </div>
              {a.kind === 'backorder' ? (
                <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); nav(`/quotations/${a.quotation_id}?tab=fulfill`); }}>Consolidate</button>
              ) : (
                <>
                  {a.kind === 'stalled' && <button className="btn sm" onClick={(e) => { e.stopPropagation(); alertAction(a.id, 'nudge'); }}>Nudge</button>}
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); alertAction(a.id, 'escalate'); }}>Escalate</button>
                </>
              )}
              <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); alertAction(a.id, 'dismiss'); }}>Dismiss</button>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-row3" style={{ paddingBottom: 16 }}>
        <div className="card pad">
          <h3>Top products <span className="muted">by revenue</span></h3>
          <HBars data={kpi.top_products.map((p) => ({ label: p.description, value: Math.round(p.revenue) }))} fmt={(v) => fmtMoney0(v)} />
        </div>
        <div className="card pad">
          <h3>Top salespeople <span className="muted">won revenue, USD eq.</span></h3>
          <HBars data={(kpi.top_reps || []).map((r) => ({ label: r.name, value: Math.round(r.revenue), sub: `${r.deals} deals · ${Number(r.margin).toFixed(1)}% margin` }))} fmt={(v) => fmtMoney0(v)} />
          <h3 style={{ marginTop: 16 }}>Pipeline by stage</h3>
          <HBars data={STATUS_KANBAN.filter((s) => statusMap[s]).map((s) => ({
            label: s.replace(/_/g, ' '), value: statusMap[s].c, color: '#017E84',
          }))} fmt={(v) => `${v} orders`} />
        </div>
        <div className="card pad">
          <h3>Quotation statuses</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(kpi.quotes_by_status || []).sort((a, b) => b.c - a.c).map((s) => (
              <div key={s.status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#F7F8FA', borderRadius: 6, padding: '7px 10px' }}>
                <Pill status={s.status} />
                <b>{s.c}</b>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: '0 18px 20px', color: 'var(--muted)', fontSize: 12 }}>
        Signed in as <Avatar name={user?.name} size={18} /> <b>{user?.name}</b> — role: <b style={{ textTransform: 'capitalize' }}>{user?.role}</b>
        {user?.sales_team ? ` · team ${user.sales_team}` : ''}
      </div>
    </>
  );
}
