import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtMoney, fmtDate, fmtDateTime, fmtPct, STATUS_COLORS } from '../api';
import ListView from '../components/ListView';
import { Pill, Avatar, Modal, useToast, RiskBar, DropBtn } from '../components/ui';
import { useAuth } from '../auth';
import ProductImage from '../components/ProductImage';

/* ============================================================ QUOTATIONS LIST */
export function Quotations({ mode = 'all', openNew = false, initialView = 'list' }) {
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const [quotes, setQuotes] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [view, setView] = useState(initialView);
  useEffect(() => { setView(initialView); }, [initialView]);
  const [mine, setMine] = useState(user?.role === 'salesrep');
  const [showNew, setShowNew] = useState(openNew);
  const [custId, setCustId] = useState('');
  const [delivery, setDelivery] = useState('');
  const [qs] = useSearchParams();
  const [chip, setChip] = useState(['confirm', 'drafts', 'deliver'].includes(qs.get('chip')) ? qs.get('chip') : null); // KPI chip acting as a list filter (deep-linkable via ?chip=)
  const { toast } = useToast();

  const load = () => api.get(`/quotations${mine ? '?mine=1' : ''}`).then((r) => setQuotes(r.quotations)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [mine]);
  useEffect(() => { api.get('/customers').then((r) => setCustomers(r.customers)).catch(() => {}); }, []);

  if (!quotes) return <div className="page-loading">Loading quotations…</div>;

  const ORDER_STATUSES = ['confirmed', 'fulfilling', 'fulfilled'];
  const base = mode === 'orders' ? quotes.filter((q) => ORDER_STATUSES.includes(q.status)) : quotes;
  const CHIP_FILTERS = {
    confirm: (q) => q.status.startsWith('pending'),
    drafts: (q) => ['draft', 'returned'].includes(q.status),
    deliver: (q) => ['confirmed', 'fulfilling'].includes(q.status),
  };
  const rows = chip ? base.filter(CHIP_FILTERS[chip]) : base;
  const toggleChip = (key) => setChip((c) => (c === key ? null : key));
  const count = (fn) => base.filter(fn).length;
  const toConfirm = count((q) => q.status.startsWith('pending'));
  const toDeliver = count((q) => ['confirmed', 'fulfilling'].includes(q.status));
  const drafts = count((q) => ['draft', 'returned'].includes(q.status));
  const pipelineVal = rows.filter((q) => !['rejected', 'cancelled'].includes(q.status)).reduce((s, q) => s + q.total / (q.exchange_rate || 1), 0);

  const createQuote = async () => {
    try {
      const r = await api.post('/quotations', { customer_id: Number(custId), expected_delivery: delivery || null });
      toast(`Quotation ${r.quotation.number} created`, 'ok');
      setShowNew(false); setCustId(''); setDelivery('');
      nav(`/quotations/${r.quotation.id}`);
    } catch (e) { toast(e.message, 'err'); }
  };

  const KANBAN = [
    ['draft', 'New'], ['pending_manager', 'To Approve'], ['pending_finance', 'Finance Review'], ['approved', 'Ready'],
    ['sent', 'Sent'], ['negotiating', 'Negotiating'], ['confirmed', 'Confirmed'], ['fulfilling', 'Fulfilling'], ['fulfilled', 'Won'], ['rejected', 'Lost'],
  ];

  const reloadData = () => { setQuotes(null); toast('Reloading pricing, stock and approval data…', ''); load(); };

  return (
    <>
      {/* Sales workspace top menu (B1): Quotations · Pipeline · Reload Data · Go to Back-end · Close Workspace */}
      <div className="ws-bar">
        <span className="ws-title">Sales Workspace</span>
        <div className="seg">
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>Quotations</button>
          <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>Pipeline</button>
        </div>
        <button className="btn sm" onClick={reloadData} title="Refresh pricing, stock and approval data from the backend">↻ Reload Data</button>
        {user?.role !== 'salesrep' && <button className="btn sm" onClick={() => nav('/products')} title="Open the configuration & settings area">⚙ Go to Back-end</button>}
        <button className="btn sm" onClick={() => logout().then(() => nav('/login'))} title="End the current working session">✕ Close Workspace</button>
      </div>
      <div className="kpi-chips">
        <div className={`kpi-chip ${chip === 'confirm' ? 'active' : ''}`} style={{ background: '#4C689E' }} onClick={() => toggleChip('confirm')} title="Show only quotations awaiting approval"><span className="cnt">{toConfirm}</span> To Confirm</div>
        {mode === 'all' && <div className={`kpi-chip ${chip === 'drafts' ? 'active' : ''}`} style={{ background: '#5B8A72' }} onClick={() => toggleChip('drafts')} title="Show only drafts and returned quotations"><span className="cnt">{drafts}</span> Drafts</div>}
        <div className={`kpi-chip ${chip === 'deliver' ? 'active' : ''}`} style={{ background: '#7A6DAE' }} onClick={() => toggleChip('deliver')} title="Show only confirmed orders awaiting delivery"><span className="cnt">{toDeliver}</span> To Deliver</div>
        {chip && <button className="btn sm" onClick={() => setChip(null)} style={{ alignSelf: 'center' }}>✕ Clear filter</button>}
        <div className="kpi-summary"><div><b>{fmtMoney(pipelineVal)}</b><span className="up">{chip ? `${rows.length} in filter · value (USD eq.)` : 'total value in view (USD eq.)'}</span></div></div>
      </div>

      {view === 'list' ? (
        <ListView
          rows={rows}
          onRowClick={(r) => nav(`/quotations/${r.id}`)}
          searchKeys={['number', 'customer_name', 'rep_name', 'status']}
          actions={
            <>
              {user?.role === 'salesrep' && mode === 'all' && (
                <div className="seg">
                  <button className={!mine ? 'active' : ''} onClick={() => setMine(false)}>All</button>
                  <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>Mine</button>
                </div>
              )}
              <div className="view-switch">
                <button className="active">☰</button>
                <button title="Kanban" onClick={() => setView('kanban')}>▦</button>
              </div>
              <button className="btn-new" onClick={() => setShowNew(true)}>＋ New</button>
            </>
          }
          columns={[
            { key: 'number', label: 'Number', link: true, width: 110 },
            { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at), width: 110 },
            { key: 'customer_name', label: 'Customer', render: (r) => <><Avatar name={r.customer_name} size={22} />{r.customer_name}</> },
            { key: 'rep_name', label: 'Salesperson', render: (r) => <><Avatar name={r.rep_name} size={22} />{r.rep_name}</>, width: 140 },
            { key: 'rep_team', label: 'Team', width: 90 },
            { key: 'total', label: 'Total', num: true, render: (r) => <b>{fmtMoney(r.total, r.currency)}</b>, width: 120 },
            { key: 'margin_pct', label: 'Margin', num: true, render: (r) => fmtPct(r.margin_pct), width: 80 },
            { key: 'risk_score', label: 'Risk', num: true, render: (r) => <RiskBar score={r.risk_score} />, width: 110 },
            { key: 'status', label: 'Status', render: (r) => <Pill status={r.status} />, width: 150 },
          ]}
        />
      ) : (
        <>
          <div className="ctrl-bar">
            <span className="page-title"><b>Pipeline</b></span>
            <div className="spacer" style={{ flex: 1 }} />
            <div className="view-switch">
              <button onClick={() => setView('list')}>☰</button>
              <button className="active">▦</button>
            </div>
          </div>
          <div className="kanban">
            {KANBAN.map(([status, label]) => {
              const cards = rows.filter((q) => q.status === status);
              return (
                <div className="kanban-col" key={status}>
                  <h4><span>{label}</span><span>{cards.length}</span></h4>
                  {cards.map((q) => (
                    <div className="kanban-card" key={q.id} style={{ borderLeftColor: `#${(STATUS_COLORS[q.status] || ['714B67'])[0]}` }} onClick={() => nav(`/quotations/${q.id}`)}>
                      <div className="top"><span>{q.number}</span><span>{fmtMoney(q.total, q.currency)}</span></div>
                      <div className="sub"><Avatar name={q.customer_name} size={18} />{q.customer_name}</div>
                      <div className="sub">{q.rep_name} · margin {fmtPct(q.margin_pct)}</div>
                      {q.risk_score > 0 && <div className="sub" style={{ color: '#CD3D63' }}>⚠ risk {q.risk_score}</div>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      {showNew && (
        <Modal title="New Quotation" onClose={() => setShowNew(false)}
          footer={<><button className="btn" onClick={() => setShowNew(false)}>Cancel</button><button className="btn primary" disabled={!custId} onClick={createQuote}>Create</button></>}>
          <div className="field">
            <label className="f">Customer</label>
            <select className="f" value={custId} onChange={(e) => setCustId(e.target.value)}>
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.tier} ({c.currency})</option>)}
            </select>
          </div>
          <div className="field">
            <label className="f">Expected delivery (optional)</label>
            <input className="f" type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          </div>
        </Modal>
      )}
    </>
  );
}

/* ============================================================ QUOTE DETAIL */
export function QuoteDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const { toast } = useToast();
  const [q, setQ] = useState(null);
  const [tab, setTab] = useState(params.get('tab') || 'build');
  const [sugg, setSugg] = useState([]);
  const [split, setSplit] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const r = await api.get(`/quotations/${id}`);
      setQ(r.quotation);
      if (['approved'].includes(r.quotation.status)) api.get(`/quotations/${id}/split-suggestion`).then((s) => setSplit(s.suggestion)).catch(() => setSplit(null));
      if (['draft', 'returned', 'sent', 'negotiating'].includes(r.quotation.status)) api.get(`/quotations/${id}/upsell`).then((s) => setSugg(s.suggestions)).catch(() => {});
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); setTab(params.get('tab') || 'build'); }, [id]);

  if (err) return <div className="card pad">Error: {err} <button className="btn" onClick={() => nav('/quotations')}>Back to list</button></div>;
  if (!q) return <div className="page-loading">Loading quotation…</div>;

  const act = async (path, body, msg) => {
    try {
      const r = await api.post(path, body || {});
      if (msg) toast(msg, 'ok');
      setQ(null); await load();
      return r;
    } catch (e) { toast(e.message, 'err'); return null; }
  };

  const openCounter = (q.negotiations || []).find((n) => n.kind === 'counter' && n.status === 'open');
  const openComments = (q.negotiations || []).filter((n) => n.status === 'open');
  const canApprove = ['manager', 'admin'].includes(user.role) && q.status === 'pending_manager';
  const canApproveFinance = ['finance', 'admin'].includes(user.role) && q.status === 'pending_finance';
  const editable = ['draft', 'returned', 'negotiating', 'sent'].includes(q.status);

  const TABS = [
    ['build', 'Order Lines', q.lines?.length],
    ['approval', 'Approvals', q.approvals?.length || undefined],
    ['fulfill', 'Fulfillment', q.fulfillment?.length || undefined],
    ['billing', 'Invoicing', q.invoices?.length || undefined],
    ['commissions', 'Commission', q.commissions?.length || undefined],
    ['customer', 'Customer', openComments.length || undefined],
    ['audit', 'Audit'],
  ];

  return (
    <>
      <div className="breadcrumbs">Sales ‣ {q.status === 'draft' ? 'Quotations' : 'Orders'} <b>{q.number}</b></div>
      <div className="ctrl-bar">
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          {q.number} <Pill status={q.status} />
          {q.approval_level !== 'none' && <span className="pill" style={{ background: '#F3EDF6', color: '#714B67' }}>{q.approval_level} chain</span>}
        </h2>
        <div style={{ flex: 1 }} />
        {q.status === 'draft' || q.status === 'returned' ? (
          <button className="btn primary" onClick={() => act(`/quotations/${q.id}/submit`, {}, 'Submitted — risk routing applied')}>Submit for approval ▸</button>
        ) : null}
        {(canApprove || canApproveFinance) && (
          <DropBtn label="Approve / Reject">
            <div className="dd-item" onClick={() => act(`/quotations/${q.id}/approve`, { action: 'approve', reason: '' }, 'Approved')}>✅ Approve</div>
            <div className="dd-item" onClick={() => { const reason = prompt('Reason for return:'); if (reason !== null) act(`/quotations/${q.id}/approve`, { action: 'return', reason }, 'Returned for revision'); }}>↩ Return for revision</div>
            <div className="dd-item" onClick={() => { const reason = prompt('Reason for rejection:'); if (reason) act(`/quotations/${q.id}/approve`, { action: 'reject', reason }, 'Rejected'); }}>🚫 Reject</div>
          </DropBtn>
        )}
        {['approved', 'confirmed', 'fulfilling', 'fulfilled'].includes(q.status) && q.status !== 'sent' && (
          <button className="btn" onClick={async () => {
            const r = await act(`/quotations/${q.id}/send`, {}, 'Sent to customer portal');
            if (r?.quotation?.portal_link) { try { await navigator.clipboard.writeText(r.quotation.portal_link); toast('Portal link copied to clipboard 🔗', 'ok'); } catch {} }
          }}>📨 Send to customer</button>
        )}
      </div>

      {/* automatic prompts */}
      {q.can_consolidate && (
        <div className="banner ok">
          <span>📦 <b>Stock arrived mid-fulfillment.</b> Free stock is now available for the backordered line(s) on this order.</span>
          <span className="spacer" />
          <button className="btn sm primary" onClick={() => act(`/quotations/${q.id}/consolidate`, {}, 'Backorder consolidated into planned shipments')}>Consolidate Remaining Backorder</button>
        </div>
      )}
      {q.customer_confirmed_at && ['pending_manager', 'pending_finance'].includes(q.status) && (
        <div className="banner warn">
          <span>🔁 Customer confirmed negotiated terms on the portal at {fmtDateTime(q.customer_confirmed_at)} — the new terms breached the discount ceilings, so the quotation <b>re-entered the approval flow automatically</b>.</span>
        </div>
      )}
      {q.customer_confirmed_at && q.status === 'approved' && (
        <div className="banner ok">
          <span>✔ Customer confirmed on the portal at {fmtDateTime(q.customer_confirmed_at)} (terms within limits) — the order is ready for fulfillment. Accept the warehouse split to confirm it.</span>
        </div>
      )}
      {openCounter && (
        <div className="banner info">
          <span>💬 Open counter-offer from the customer: <b>{openCounter.proposed_discount}%</b> — accept it in the Customer tab (risk is re-evaluated automatically) or reply.</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setTab('customer')}>Review</button>
        </div>
      )}

      <div className="card pad" style={{ margin: '4px 18px' }}>
        <div className="grid4">
          <div><label className="f">Customer</label><div style={{ fontSize: 13.5 }}><Avatar name={q.customer_name} size={22} />{q.customer_name} <Pill status={`tier-${q.customer_tier}`} label={q.customer_tier} /></div></div>
          <div><label className="f">Salesperson</label><div style={{ fontSize: 13.5 }}><Avatar name={q.rep_name} size={22} />{q.rep_name} · {q.rep_team}</div></div>
          <div><label className="f">Valid until / Delivery</label><div style={{ fontSize: 13.5 }}>{fmtDate(q.valid_until)} → {fmtDate(q.expected_delivery)}</div></div>
          <div><label className="f">Blended risk score {q.approval_level !== 'none' && <span style={{ color: '#B3611E' }}>· routes to {q.approval_level === 'finance' ? 'Manager → Finance' : 'Manager'}</span>}</label><RiskBar score={q.risk_score} /></div>
        </div>
        <div className="grid4" style={{ marginTop: 12 }}>
          <div><label className="f">Untaxed total</label><b style={{ fontSize: 15 }}>{fmtMoney(q.subtotal - q.discount_total, q.currency)}</b></div>
          <div><label className="f">Discount</label><b style={{ fontSize: 15, color: '#B3611E' }}>−{fmtMoney(q.discount_total, q.currency)}</b></div>
          <div><label className="f">Taxes</label><b style={{ fontSize: 15 }}>{fmtMoney(q.tax_total, q.currency)}</b></div>
          <div><label className="f">Total · live margin</label>
            <div className="margin-ind">
              <b style={{ fontSize: 15 }}>{fmtMoney(q.total, q.currency)}</b>
              <span className="bar"><div style={{ width: `${Math.max(0, Math.min(100, q.margin_pct))}%`, background: q.margin_pct >= 30 ? '#0F7B3D' : q.margin_pct >= 20 ? '#E4A11B' : '#CD3D63' }} /></span>
              <b style={{ color: q.margin_pct >= 30 ? '#0F7B3D' : q.margin_pct >= 20 ? '#B3611E' : '#CD3D63' }}>{fmtPct(q.margin_pct)}</b>
            </div>
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([key, label, cnt]) => (
          <div key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}{cnt != null && cnt > 0 && <span className={`cnt ${key === 'customer' ? 'hot' : ''}`}>{cnt}</span>}
          </div>
        ))}
      </div>

      {tab === 'build' && <BuildTab q={q} reload={load} editable={editable} sugg={sugg} setSugg={setSugg} act={act} />}
      {tab === 'approval' && <ApprovalTab q={q} />}
      {tab === 'fulfill' && <FulfillTab q={q} split={split} setSplit={setSplit} reload={load} act={act} />}
      {tab === 'billing' && <BillingTab q={q} reload={load} act={act} />}
      {tab === 'commissions' && <CommissionTab q={q} />}
      {tab === 'customer' && <CustomerTab q={q} act={act} />}
      {tab === 'audit' && <AuditTab q={q} />}
    </>
  );
}

/* ---------- BUILD TAB (lines + upsell) ---------- */
function BuildTab({ q, reload, editable, sugg, setSugg, act }) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [od, setOd] = useState(String(q.order_discount_pct || 0));
  const [dismissed, setDismissed] = useState(String(q.dismissed_suggestions || '').split(',').filter(Boolean).map(Number));

  const updLine = async (lineId, patch) => {
    try { await api.put(`/quotations/${q.id}/lines/${lineId}`, patch); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const delLine = async (lineId) => {
    try { await api.del(`/quotations/${q.id}/lines/${lineId}`); reload(); } catch (e) { toast(e.message, 'err'); }
  };
  const saveOd = async () => {
    try { await api.put(`/quotations/${q.id}/order-discount`, { order_discount_pct: Number(od) }); toast('Order-level discount applied', 'ok'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const addUpsell = async (pid) => {
    try { const r = await api.post(`/quotations/${q.id}/upsell/${pid}/add`, {}); setSugg(r.quotation.suggestions || []); reload(); toast('Suggestion added to order', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const dismissUpsell = async (pid, undo) => {
    try { const r = await api.post(`/quotations/${q.id}/upsell/${pid}/dismiss`, { undo }); setSugg(r.suggestions || []); setDismissed(r.dismissed || []); toast(undo ? 'Suggestion restored' : 'Suggestion dismissed', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className='tab-grid side-320'>
      <div className="card" style={{ margin: 0 }}>
        <div className="ctrl-bar" style={{ padding: '10px 14px 4px' }}>
          <h3 style={{ margin: 0 }}>Order Lines</h3>
          <div style={{ flex: 1 }} />
          {editable && <button className="btn-new" onClick={() => setShowAdd(true)}>＋ Add line</button>}
        </div>
        <table className="list">
          <thead><tr>
            <th>Product</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Disc %</th>
            <th className="num">Eff. disc</th><th className="num">Ceiling</th><th className="num">Subtotal</th><th className="num">Margin</th>
            {editable && <th></th>}
          </tr></thead>
          <tbody>
            {(q.lines || []).map((l) => {
              const viol = l.violation > 0;
              return (
                <tr key={l.id}>
                  <td>
                    <ProductImage product={l} size={28} style={{ marginRight: 8 }} />
                    <b>{l.description}</b>
                    {l.line_type === 'subscription' && <span className="pill" style={{ background: '#E5F0F0', color: '#017E84', marginLeft: 8 }}>recurring · {l.billing_period}</span>}
                    {viol && <span className="pill" style={{ background: '#F5D2D2', color: '#B3261E', marginLeft: 6 }}>+{l.violation} over</span>}
                  </td>
                  {editable ? (
                    <>
                      <td className="num">
                        <span className="qty-step" title="Adjust quantity">
                          <button onClick={() => l.qty > 1 && updLine(l.id, { qty: l.qty - 1 })} disabled={l.qty <= 1}>−</button>
                          <input type="number" key={`${l.id}-${l.qty}`} defaultValue={l.qty} min="1" onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v !== l.qty) updLine(l.id, { qty: v }); }} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                          <button onClick={() => updLine(l.id, { qty: l.qty + 1 })}>+</button>
                        </span>
                      </td>
                      <td className="num">{fmtMoney(l.unit_price, q.currency)}</td>
                      <td className="num"><input className="f" style={{ width: 62, textAlign: 'right', borderColor: viol ? '#CD3D63' : undefined }} type="number" min="0" max="90" key={`${l.id}-d-${l.discount_pct}`} defaultValue={l.discount_pct}
                        onBlur={(e) => Number(e.target.value) !== l.discount_pct && updLine(l.id, { discount_pct: Math.max(0, Math.min(90, Number(e.target.value))) })} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} /></td>
                    </>
                  ) : (
                    <>
                      <td className="num">{l.qty}</td><td className="num">{fmtMoney(l.unit_price, q.currency)}</td><td className="num">{l.discount_pct}%</td>
                    </>
                  )}
                  <td className="num" style={{ color: viol ? '#B3261E' : 'inherit' }}>{l.effective_discount}%</td>
                  <td className="num" style={{ color: 'var(--muted)' }}>{l.allowed_discount}%</td>
                  <td className="num"><b>{fmtMoney(l.net, q.currency)}</b></td>
                  <td className="num" style={{ color: l.margin_pct >= 30 ? '#0F7B3D' : '#B3611E' }}>{l.margin_pct}%</td>
                  {editable && <td><button className="btn sm danger" onClick={() => delLine(l.id)}>✕</button></td>}
                </tr>
              );
            })}
            {!q.lines?.length && <tr><td colSpan={9}><div className="empty-state">No lines yet — add products or accept an upsell suggestion</div></td></tr>}
          </tbody>
        </table>
        <div style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid #EEF0F3' }}>
          <label style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>Order-level discount %</label>
          <input className="f" style={{ width: 80 }} type="number" value={od} onChange={(e) => setOd(e.target.value)} disabled={!editable} />
          <button className="btn sm" onClick={saveOd} disabled={!editable}>Apply</button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 13 }}>Subtotal <b>{fmtMoney(q.subtotal, q.currency)}</b></div>
          <div style={{ fontSize: 13, color: '#B3611E' }}>Discount <b>−{fmtMoney(q.discount_total, q.currency)}</b></div>
          <div style={{ fontSize: 13 }}>Tax <b>{fmtMoney(q.tax_total, q.currency)}</b></div>
          <div style={{ fontSize: 14 }}>Total <b>{fmtMoney(q.total, q.currency)}</b></div>
        </div>
      </div>

      <div className="card pad" style={{ margin: 0 }}>
        <h3>💡 Smart upsell / cross-sell</h3>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>
          Ranked by co-purchase score; margin-guarded — suggestions below {30}% product margin never surface.
        </div>
        {!editable && <div style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>Quote is locked — unlock by returning for revision.</div>}
        {sugg.map((s) => (
          <div key={s.product_id} style={{ border: '1px solid #EDE0F0', borderRadius: 8, padding: '9px 11px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <ProductImage product={s} size={30} style={{ marginRight: 8, verticalAlign: "top" }} /><b style={{ fontSize: 13 }}>{s.name}</b>
              <span className="score-tag">{s.score.toFixed(2)}</span>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 11.5, margin: '3px 0' }}>
              {s.category} · {fmtMoney(s.price)} {s.promoted && <span className="promo-tag">promoted</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, alignItems: 'center' }}>
              <span>+{fmtMoney(s.margin_delta)} margin → order {s.order_margin_after}%</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm" disabled={!editable} onClick={() => dismissUpsell(s.product_id)} title="Dismiss suggestion">Dismiss</button>
                <button className="btn sm primary" disabled={!editable} onClick={() => addUpsell(s.product_id)}>Add</button>
              </span>
            </div>
          </div>
        ))}
        {dismissed.length > 0 && (
          <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 6 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 5 }}>Dismissed ({dismissed.length}):</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {dismissed.map((pid) => (
                <button key={pid} className="btn sm" onClick={() => dismissUpsell(pid, true)}>↩ #{pid}</button>
              ))}
            </div>
          </div>
        )}
        {!sugg.length && editable && <div className="empty-state" style={{ padding: 18 }}>No suggestions — add a line first</div>}
      </div>

      {showAdd && <AddLineModal q={q} onClose={() => setShowAdd(false)} reload={reload} />}
    </div>
  );
}

function AddLineModal({ q, onClose, reload }) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState(null);
  const [sel, setSel] = useState('');
  const [variant, setVariant] = useState('');
  const [qty, setQty] = useState('1');
  const [disc, setDisc] = useState('0');
  const [plan, setPlan] = useState('');

  useEffect(() => {
    api.get('/products').then((r) => {
      const withVars = r.products.filter((p) => p.active);
      setCatalog({ products: withVars, variants: r.variants, plans: r.plans });
    }).catch((e) => toast(e.message, 'err'));
  }, []);

  const product = catalog?.products.find((p) => p.id === Number(sel));
  const variants = (catalog?.variants || []).filter((v) => v.product_id === Number(sel));
  const productPlans = (catalog?.plans || []).filter((p) => p.product_id === Number(sel));

  const add = async () => {
    try {
      await api.post(`/quotations/${q.id}/lines`, {
        product_id: Number(sel), variant_id: variant ? Number(variant) : null,
        qty: Number(qty) || 1, discount_pct: Number(disc) || 0, plan_id: plan ? Number(plan) : null,
      });
      toast('Line added', 'ok'); reload(); onClose();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal title="Add product line" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!sel} onClick={add}>Add line</button></>}>
      <div className="field">
        <label className="f">Product</label>
        <select className="f" value={sel} onChange={(e) => { setSel(e.target.value); setVariant(''); setPlan(''); }}>
          <option value="">Select…</option>
          {(catalog?.products || []).map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.sku}) · {p.category_name} · {p.product_type === 'subscription' ? 'recurring' : 'one-time'}</option>
          ))}
        </select>
      </div>
      {variants.length > 0 && (
        <div className="field">
          <label className="f">Variant</label>
          <select className="f" value={variant} onChange={(e) => setVariant(e.target.value)}>
            <option value="">Standard</option>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.value} (+{fmtMoney(v.extra_price)})</option>)}
          </select>
        </div>
      )}
      {product?.product_type === 'subscription' && productPlans.length > 0 && (
        <div className="field">
          <label className="f">Billing plan</label>
          <select className="f" value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">Default ({productPlans[0].plan_name})</option>
            {productPlans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.plan_name} — {fmtMoney(p.recurring_price)}/{p.billing_period}</option>)}
          </select>
        </div>
      )}
      <div className="grid2">
        <div className="field"><label className="f">Quantity</label><input className="f" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
        <div className="field"><label className="f">Line discount %</label><input className="f" type="number" min="0" max="90" value={disc} onChange={(e) => setDisc(e.target.value)} /></div>
      </div>
      {product && (
        <div style={{ background: '#F7F8FA', borderRadius: 6, padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          Category ceiling: <b>{product.discount_ceiling}%</b> · customer tier ceiling applies on top. Exceeding → approval routing.
        </div>
      )}
    </Modal>
  );
}

/* ---------- APPROVAL TAB ---------- */
function ApprovalTab({ q }) {
  const risk = q.risk || {};
  return (
    <div className='tab-grid halves'>
      <div className="card pad" style={{ margin: 0 }}>
        <h3>Approval chain</h3>
        {(q.approvals || []).length === 0 && <div className="empty-state">No approval required for this quotation (risk within limits)</div>}
        <div className="timeline">
          {(q.approvals || []).map((a) => (
            <div className="tl-item" key={a.id}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b style={{ textTransform: 'capitalize' }}>{a.level}</b>
                <Pill status={a.status === 'approved' ? 'fulfilled' : a.status === 'pending' ? 'pending_manager' : a.status === 'waiting' ? 'draft' : a.status === 'rejected' ? 'rejected' : 'returned'} label={a.status} />
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {a.approver_name ? `by ${a.approver_name}` : 'awaiting'} {a.decided_at && `· ${fmtDateTime(a.decided_at)}`}
              </div>
              {a.reason && <div style={{ fontSize: 12.5, marginTop: 2, fontStyle: 'italic' }}>“{a.reason}”</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="card pad" style={{ margin: 0 }}>
        <h3>Discount risk breakdown <span className="muted">blended score {risk.risk_score}</span></h3>
        <table className="list">
          <thead><tr><th>Line</th><th>Category</th><th className="num">Given</th><th className="num">Allowed</th><th className="num">Violation</th></tr></thead>
          <tbody>
            {(risk.line_breakdown || []).map((l) => (
              <tr key={l.line_id}>
                <td>{l.product}</td><td>{l.category}</td>
                <td className="num">{l.discount_given}%</td>
                <td className="num">{l.allowed}%</td>
                <td className="num" style={{ color: l.violation > 0 ? '#B3261E' : '#0F7B3D' }}><b>{l.violation > 0 ? `+${l.violation}` : '✓'}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>
          Blended risk = worst violation <b>{risk.max_violation}</b> + 50% of remaining overage ({risk.total_overage} total).
          {risk.worst_line && <> Worst line: <b>{risk.worst_line.product}</b> at {risk.worst_line.given}% (ceiling {risk.worst_line.allowed}%).</>}
        </div>
      </div>
    </div>
  );
}

/* ---------- FULFILLMENT TAB ---------- */
function FulfillTab({ q, split, setSplit, reload, act }) {
  const { toast } = useToast();
  const [overrideOpen, setOverrideOpen] = useState(false);
  useEffect(() => {
    if (['approved', 'confirmed', 'fulfilling'].includes(q.status)) {
      api.get(`/quotations/${q.id}/split-suggestion`).then((r) => setSplit(r.suggestion)).catch(() => setSplit(null));
    }
  }, [q.status, q.id]);

  const refreshSplit = async () => {
    try { const r = await api.get(`/quotations/${q.id}/split-suggestion`); setSplit(r.suggestion); } catch { setSplit(null); }
  };
  useEffect(() => { if (q.status === 'approved') refreshSplit(); }, [q.status]);

  const acceptSplit = () => act(`/quotations/${q.id}/split/accept`, {}, 'Split accepted — order confirmed');
  const ship = (splitId) => act(`/quotations/${q.id}/ship`, { split_id: splitId }, 'Shipment dispatched');
  const consolidate = () => act(`/quotations/${q.id}/consolidate`, {}, 'Backorder consolidated');

  return (
    <div className='tab-grid side-340'>
      <div className="card" style={{ margin: 0 }}>
        <div className="ctrl-bar" style={{ padding: '10px 14px 4px' }}><h3 style={{ margin: 0 }}>Warehouse allocations</h3></div>
        <table className="list">
          <thead><tr><th>Product</th><th>Warehouse</th><th className="num">Qty</th><th>Status</th><th>Shipped at</th><th></th></tr></thead>
          <tbody>
            {(q.fulfillment || []).map((f) => (
              <tr key={f.id}>
                <td>{f.description}</td>
                <td>{f.warehouse_name}</td>
                <td className="num">{f.qty}</td>
                <td><Pill status={f.status} /></td>
                <td>{fmtDateTime(f.shipped_at)}</td>
                <td>{f.status === 'planned' && <button className="btn sm primary" onClick={() => ship(f.id)}>🚚 Ship</button>}</td>
              </tr>
            ))}
            {!q.fulfillment?.length && <tr><td colSpan={6}><div className="empty-state">No fulfillment plan yet — accept the suggested split</div></td></tr>}
          </tbody>
        </table>
        {(q.fulfillment || []).some((f) => f.status === 'backorder') && (
          <div style={{ padding: 12, display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid #EEF0F3' }}>
            <span style={{ fontSize: 13 }}>{q.can_consolidate ? '📦 Stock arrived — free units are available for the backordered line(s).' : '⏳ Backorder open — the prompt to consolidate appears automatically when stock arrives.'}</span>
            <button className={`btn ${q.can_consolidate ? 'primary' : ''}`} disabled={!q.can_consolidate} onClick={consolidate}>Consolidate Remaining Backorder</button>
            {!q.can_consolidate && <span style={{ fontSize: 12, color: 'var(--muted)' }}>no free stock yet (restock or run replenishment in Warehouses)</span>}
          </div>
        )}
      </div>

      <div className="card pad" style={{ margin: 0 }}>
        <h3>📦 Smart split suggestion</h3>
        {split && split.lines.length ? (
          <>
            {(split.per_warehouse || []).map((w) => (
              <div key={w.warehouse_id} style={{ border: '1px solid #E5E0EE', borderRadius: 8, padding: '8px 11px', marginBottom: 7, fontSize: 12.5 }}>
                <b>{w.warehouse}</b>
                <div style={{ color: 'var(--muted)' }}>
                  ship {w.qty} unit(s){w.backorder > 0 && <span style={{ color: '#B3261E' }}> · backorder {w.backorder}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {(split.lines || []).filter((l) => l.warehouse_id === w.warehouse_id).map((l) => `${l.qty} × ${l.product}${l.status === 'backorder' ? ' (backorder)' : ''}`).join(' · ')}
                </div>
              </div>
            ))}
            <div style={{ fontSize: 13, margin: '8px 0' }}>
              <b>{split.shipment_count}</b> shipment(s) · est. logistics <b>{fmtMoney(split.est_cost)}</b>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>uses free stock only — units already promised to other confirmed orders are excluded</div>
            </div>
            {q.status === 'approved' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={acceptSplit}>Accept split → confirm order</button>
                <button className="btn" onClick={() => setOverrideOpen(true)}>✎ Manual override</button>
              </div>
            )}
            {q.status !== 'approved' && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Split is live — allocations shown on the left.</div>}
          </>
        ) : (
          <div className="empty-state" style={{ padding: 18 }}>
            {['approved', 'confirmed', 'fulfilling'].includes(q.status)
              ? 'All stocked lines fulfilled (or only non-stock lines).'
              : 'Fulfillment planning starts once the quotation is approved.'}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
          Greedy consolidation: prefers warehouses already shipping this order, then largest availability, then cheapest freight.
        </div>
      </div>

      {overrideOpen && <OverrideModal q={q} split={split} onClose={() => setOverrideOpen(false)} act={act} />}
    </div>
  );
}

/* manual warehouse allocation (B6 requirement) — defaults prefilled from the smart suggestion */
function OverrideModal({ q, split, onClose, act }) {
  const { toast } = useToast();
  const [warehouses, setWarehouses] = useState([]);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/warehouses').then((r) => setWarehouses(r.warehouses.filter((w) => w.active))).catch(() => {});
    const stocked = (q.lines || []).filter((l) => l.product_type !== 'subscription' && l.line_type === 'one_time');
    const byLine = {};
    (split?.lines || []).forEach((s) => {
      byLine[s.line_id] = byLine[s.line_id] || [];
      byLine[s.line_id].push(s);
    });
    setRows(stocked.flatMap((l) => {
      const suggRows = byLine[l.id] || [{ warehouse_id: (warehouses[0] || {}).id, qty: l.qty, status: 'planned' }];
      return suggRows.map((s) => ({ line_id: l.id, label: l.description, warehouse_id: s.warehouse_id, qty: s.qty, status: s.status || 'planned' }));
    }));
  }, []);

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const apply = async () => {
    if (rows.some((r) => !r.warehouse_id || !(r.qty >= 0))) {
      toast('Every line needs a warehouse and a valid quantity', 'err');
      return;
    }
    setBusy(true);
    const r = await act(`/quotations/${q.id}/split/override`, { splits: rows }, 'Manual split applied — order confirmed');
    setBusy(false);
    if (r) onClose();
  };

  return (
    <Modal title="Manual warehouse override" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !rows.length} onClick={apply}>Apply override → confirm order</button></>}>
      <p style={{ marginTop: 0, fontSize: 13, color: 'var(--muted)' }}>
        Allocate each line yourself — defaults come from the smart suggestion. Quantities are validated against live stock when shipping.
      </p>
      <table className="list">
        <thead><tr><th>Line</th><th>Warehouse</th><th className="num">Qty</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.label}</td>
              <td>
                <select className="f" style={{ width: 170 }} value={r.warehouse_id || ''} onChange={(e) => setRow(i, { warehouse_id: Number(e.target.value) })}>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </td>
              <td className="num"><input className="f" style={{ width: 80, textAlign: 'right' }} type="number" min="0" value={r.qty} onChange={(e) => setRow(i, { qty: Number(e.target.value) })} /></td>
              <td>
                <select className="f" style={{ width: 130 }} value={r.status} onChange={(e) => setRow(i, { status: e.target.value })}>
                  <option value="planned">Planned</option>
                  <option value="backorder">Backorder</option>
                </select>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4}><div className="empty-state">No stocked lines on this order</div></td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}

/* ---------- BILLING TAB ---------- */
function BillingTab({ q, reload, act }) {
  const { toast } = useToast();
  const pay = async (invId) => {
    try { await api.post(`/invoices/${invId}/pay`, {}); toast('Payment recorded', 'ok'); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const genDue = () => act(`/quotations/${q.id}/billing/generate`, {}, 'Due recurring cycles invoiced');
  const subAct = async (lineId, body) => {
    try {
      const r = await api.post(`/quotations/${q.id}/lines/${lineId}/subscription`, body);
      if (body.action === 'modify') {
        const p = r.proration || {};
        toast(p.delta ? `Qty ${p.old_qty}→${p.new_qty}: ${p.delta > 0 ? 'prorated charge' : 'credit note'} ${fmtMoney(Math.abs(p.delta), q.currency)} for ${p.days_remaining}/${p.days_in_cycle} days left in cycle`
          : `Qty ${p.old_qty}→${p.new_qty}: plan proration rule "${p.rule}" — applies from next cycle`, 'ok');
      } else {
        const c = r.credit || {};
        toast(c.refund > 0 ? `Cancelled — credit note ${fmtMoney(c.refund, q.currency)} (${c.policy}, ${c.days_remaining}/${c.days_in_cycle} days unused${c.notice_days ? `, ${c.notice_days}-day notice` : ''})` : `Cancelled — no refund due (${c.policy})`, 'ok');
      }
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const subLines = (q.lines || []).filter((l) => l.line_type === 'subscription');

  return (
    <div className='tab-grid halves'>
      <div>
        <div className="card" style={{ margin: '0 0 12px' }}>
          <div className="ctrl-bar" style={{ padding: '10px 14px 4px' }}>
            <h3 style={{ margin: 0 }}>Invoices</h3>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={genDue}>Generate due cycles</button>
          </div>
          <table className="list">
            <thead><tr><th>Number</th><th>Type</th><th className="num">Amount</th><th>Status</th><th>Due</th><th></th></tr></thead>
            <tbody>
              {(q.invoices || []).map((i) => (
                <tr key={i.id}>
                  <td className="link-cell">{i.number}</td>
                  <td>{i.kind === 'credit_note' ? <span style={{ color: '#0F7B3D' }}>Credit note</span> : i.kind}</td>
                  <td className="num"><b>{fmtMoney(i.amount, q.currency)}</b></td>
                  <td><Pill status={i.status} /></td>
                  <td>{fmtDate(i.due_date)}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 6 }}>
                      {i.status === 'open' && <button className="btn sm success" onClick={() => pay(i.id)}>💰 Pay</button>}
                      <a className="btn sm" href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">⬇ PDF</a>
                    </span>
                  </td>
                </tr>
              ))}
              {!q.invoices?.length && <tr><td colSpan={6}><div className="empty-state">Invoices generate when the order is confirmed</div></td></tr>}
            </tbody>
          </table>
        </div>

        {subLines.length > 0 && (
          <div className="card pad" style={{ margin: 0 }}>
            <h3>🔄 Subscription management</h3>
            {subLines.map((l) => (
              <div key={l.id} style={{ border: '1px solid #E8EAF0', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <b style={{ fontSize: 13 }}>{l.description}</b> — qty {l.qty} × {fmtMoney(l.unit_price, q.currency)}
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <input className="f" style={{ width: 90 }} type="number" id={`qty-${l.id}`} placeholder="new qty" min="1" />
                  <button className="btn sm" onClick={() => { const v = document.getElementById(`qty-${l.id}`).value; if (v) subAct(l.id, { action: 'modify', qty: Number(v) }); }}>Modify (prorated)</button>
                  <button className="btn sm danger" onClick={() => { if (confirm(`Cancel ${l.description}? A credit note is issued per plan policy.`)) subAct(l.id, { action: 'cancel' }); }}>Cancel</button>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Mid-cycle changes prorate over the remaining days of the <i>current</i> cycle (anchored on the last invoiced date) per the plan's proration rule; cancellation issues a credit note per the plan's refund policy and notice period.</div>
          </div>
        )}
      </div>

      <div className="card" style={{ margin: 0 }}>
        <div className="ctrl-bar" style={{ padding: '10px 14px 4px' }}><h3 style={{ margin: 0 }}>Recurring billing schedule</h3></div>
        <table className="list">
          <thead><tr><th>Cycle</th><th>Line</th><th className="num">Amount</th><th>Date</th><th>Status</th></tr></thead>
          <tbody>
            {(q.schedule || []).map((s) => (
              <tr key={s.id}>
                <td>{s.description?.includes('cycle') ? s.description.split('cycle')[1]?.trim() : '—'}</td>
                <td>{s.description?.split('—')[0]}</td>
                <td className="num">{fmtMoney(s.amount, q.currency)}</td>
                <td>{fmtDate(s.scheduled_date)}</td>
                <td><Pill status={s.status} /></td>
              </tr>
            ))}
            {!q.schedule?.length && <tr><td colSpan={5}><div className="empty-state">No recurring lines on this order</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- COMMISSION TAB (quote-linked) ---------- */
function CommissionTab({ q }) {
  return (
    <div className="card" style={{ margin: '12px 18px' }}>
      <div className="ctrl-bar" style={{ padding: '10px 14px 4px' }}>
        <h3 style={{ margin: 0 }}>Commissions on this order</h3>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Generated automatically when invoices are fully paid</span>
      </div>
      <table className="list">
        <thead><tr><th>Number</th><th>Salesperson</th><th>Rule</th><th className="num">Base</th><th className="num">Rate</th><th className="num">Commission</th><th>Status</th></tr></thead>
        <tbody>
          {(q.commissions || []).map((c) => (
            <tr key={c.id}>
              <td className="link-cell">{c.number}</td>
              <td>{c.salesperson_name}</td>
              <td>{c.rule_name}</td>
              <td className="num">{fmtMoney(c.base_amount)}</td>
              <td className="num">{c.rate_type === 'fixed' ? fmtMoney(c.rate) : `${c.rate}%`}</td>
              <td className="num"><b>{fmtMoney(c.amount)}</b></td>
              <td><Pill status={c.status} /></td>
            </tr>
          ))}
          {!q.commissions?.length && (
            <tr><td colSpan={7}><div className="empty-state">No commissions yet — pay the invoices to trigger the commission engine</div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- CUSTOMER / PORTAL TAB ---------- */
function CustomerTab({ q, act }) {
  const { toast } = useToast();
  const [reply, setReply] = useState('');
  const [replyLine, setReplyLine] = useState('');
  const link = `${window.location.origin}/#${q.portal_url}`;
  const thread = [...(q.negotiations || [])].sort((a, b) => a.id - b.id);
  const sendReply = async () => {
    const r = await act(`/quotations/${q.id}/negotiation/reply`, { message: reply, line_id: replyLine ? Number(replyLine) : null }, 'Reply posted to the customer portal');
    if (r) { setReply(''); setReplyLine(''); }
  };
  return (
    <div className='tab-grid customer'>
      <div>
        <div className="card pad" style={{ margin: '0 0 12px' }}>
          <h3>🔗 Customer portal access</h3>
          <div style={{ fontSize: 13 }}>Secure per-quotation link — the customer sees <b>only this quotation</b>, can ask line-level questions, request changes, counter-offer and confirm.</div>
          <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
            <input className="f" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(link).then(() => toast('Link copied 🔗', 'ok')).catch(() => {}); }}>Copy</button>
            <a className="btn primary" href={`/#${q.portal_url}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Open ↗</a>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            The customer can also sign in to the portal with their company account and will find this quotation under “My quotations”.
            {q.customer_confirmed_at && <> · <b style={{ color: '#0F7B3D' }}>Customer confirmed {fmtDateTime(q.customer_confirmed_at)}</b></>}
          </div>
        </div>
        <div className="card pad" style={{ margin: 0 }}>
          <h3>↩ Reply to the customer</h3>
          <div className="field"><label className="f">About</label>
            <select className="f" value={replyLine} onChange={(e) => setReplyLine(e.target.value)}>
              <option value="">Whole quotation</option>
              {(q.lines || []).map((l) => <option key={l.id} value={l.id}>{l.description}</option>)}
            </select>
          </div>
          <div className="field"><label className="f">Message</label>
            <textarea className="f" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="e.g. Onboarding is included in the Installation & Setup line — happy to add a training day at 10%." />
          </div>
          <button className="btn primary" disabled={!reply.trim()} onClick={sendReply}>Send reply to portal</button>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Replies appear instantly in the customer's portal thread — no email back-and-forth.</div>
        </div>
      </div>
      <div className="card pad" style={{ margin: 0 }}>
        <h3>💬 Negotiation thread <span className="muted">{thread.filter((n) => n.status === 'open').length} open</span></h3>
        {thread.length === 0 && <div className="empty-state" style={{ padding: 16 }}>No customer activity yet — share the portal link.</div>}
        <div className="thread-scroll" style={{ maxHeight: 460 }}>
          {thread.map((n) => (
            <div key={n.id} className={`bubble ${n.user_id ? 'me' : 'them'}`}>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 3 }}>
                {n.user_id ? `${n.user_name} (staff)` : (n.user_name || 'Customer')} · {n.kind === 'change_request' ? 'change request' : n.kind === 'counter' ? 'counter-offer' : n.user_id ? 'reply' : 'question'}
                {n.line_label && <> · <span className="line-chip">{n.line_label}</span></>}
                {n.proposed_discount != null && ` · ${n.proposed_discount}%`} · {fmtDateTime(n.created_at)}
              </div>
              {n.message}
              {n.status === 'open' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 7, alignItems: 'center' }}>
                  <button className="btn sm success" onClick={() => act(`/quotations/${q.id}/negotiation/${n.id}`, { action: 'accept' }, n.kind === 'counter' ? 'Counter accepted — risk re-evaluated' : 'Request accepted')}>
                    {n.kind === 'counter' ? `Accept ${n.proposed_discount}% on all lines` : 'Accept'}
                  </button>
                  <button className="btn sm danger" onClick={() => act(`/quotations/${q.id}/negotiation/${n.id}`, { action: 'decline' }, 'Request declined')}>Decline</button>
                  {n.kind === 'counter' && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>accepting re-runs the blended-risk router</span>}
                </div>
              )}
              {n.status !== 'open' && n.status !== 'info' && <div style={{ fontSize: 11.5, color: n.status === 'accepted' ? '#0F7B3D' : '#B3261E', marginTop: 4 }}>● {n.status}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- AUDIT TAB ---------- */
function AuditTab({ q }) {
  return (
    <div className="card pad" style={{ margin: '12px 18px' }}>
      <h3>🧾 Full audit trail</h3>
      <div className="timeline">
        {(q.audit || []).map((a) => (
          <div className="tl-item" key={a.id}>
            <b style={{ fontSize: 13 }}>{a.action.replace(/_/g, ' ')}</b>
            <div style={{ fontSize: 12.5 }}>{a.details}</div>
            <div className="when">{a.user_name} · {fmtDateTime(a.created_at)}</div>
          </div>
        ))}
        {!q.audit?.length && <div className="empty-state">No activity recorded</div>}
      </div>
    </div>
  );
}
