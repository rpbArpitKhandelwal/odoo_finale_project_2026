import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtMoney, fmtDate } from '../api';
import ListView from '../components/ListView';
import { Pill, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

export default function Invoices() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [payTarget, setPayTarget] = useState(null);
  const [method, setMethod] = useState('bank_transfer');
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false); // "To Collect" chip acts as a filter

  const load = () => api.get('/invoices').then(setData).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return <div className="page-loading">Loading invoices…</div>;

  const invoices = (kind ? data.invoices.filter((i) => i.kind === kind) : data.invoices).filter((i) => !onlyOpen || (i.status === 'open' && i.kind !== 'credit_note'));
  const usd = (i) => i.amount / (i.exchange_rate || 1); // KPI sums in the reporting currency (USD)
  const open = data.invoices.filter((i) => i.status === 'open' && i.kind !== 'credit_note');
  const openSum = open.reduce((s, i) => s + usd(i), 0);
  const paidSum = data.invoices.filter((i) => i.status === 'paid' && i.kind !== 'credit_note').reduce((s, i) => s + usd(i), 0);
  const creditSum = data.invoices.filter((i) => i.kind === 'credit_note' && i.status !== 'void').reduce((s, i) => s + usd(i), 0);
  const canBill = ['admin', 'finance'].includes(user.role);
  const runBilling = async () => {
    try {
      const r = await api.post('/billing/run-due', {});
      toast(r.created ? `Recurring billing run: ${r.created} due cycle(s) invoiced` : 'No subscription cycles are due today', r.created ? 'ok' : '');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const doPay = async () => {
    try {
      await api.post(`/invoices/${payTarget.id}/pay`, { method, reference: ref });
      toast(`${payTarget.number} paid — commission engine triggered 💰`, 'ok');
      setPayTarget(null); setRef(''); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const voidInv = async (i) => {
    if (!confirm(`Void ${i.number}?`)) return;
    try { await api.post(`/invoices/${i.id}/void`, {}); toast('Invoice voided', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="kpi-chips">
        <div className={`kpi-chip ${onlyOpen ? 'active' : ''}`} style={{ background: '#B3611E' }} onClick={() => setOnlyOpen((v) => !v)} title="Show only open invoices"><span className="cnt">{open.length}</span> To Collect</div>
        <div className="kpi-summary">
          <div><b>{fmtMoney(openSum)}</b><span className="up">open receivables (USD eq.)</span></div>
          <div><b>{fmtMoney(paidSum)}</b><span className="up">collected (USD eq.)</span></div>
          <div><b style={{ color: '#0F7B3D' }}>{fmtMoney(creditSum)}</b><span className="up">credit notes</span></div>
          {canBill && <div><button className="btn primary sm" onClick={runBilling} title="Invoice every subscription cycle whose date has arrived">⟳ Run recurring billing ({data.due_cycles || 0} due)</button></div>}
        </div>
      </div>
      <ListView
        rows={invoices}
        onRowClick={(i) => nav(`/quotations/${i.quotation_id}`)}
        searchKeys={['number', 'customer_name', 'quote_number', 'status', 'kind']}
        actions={
          <>
            <select className="f" style={{ width: 140 }} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All types</option>
              <option value="one_time">One-time</option>
              <option value="recurring">Recurring</option>
              <option value="credit_note">Credit notes</option>
            </select>
          </>
        }
        columns={[
          { key: 'number', label: 'Invoice', link: true, width: 100 },
          { key: 'created_at', label: 'Date', render: (i) => fmtDate(i.created_at), width: 105 },
          { key: 'quote_number', label: 'Order', width: 95 },
          { key: 'customer_name', label: 'Customer' },
          { key: 'kind', label: 'Type', render: (i) => i.kind === 'credit_note' ? <span style={{ color: '#0F7B3D' }}>credit note</span> : i.kind },
          { key: 'amount', label: 'Amount', num: true, render: (i) => <b>{fmtMoney(i.amount, i.currency)}</b> },
          { key: 'due_date', label: 'Due', render: (i) => fmtDate(i.due_date), width: 105 },
          { key: 'status', label: 'Status', render: (i) => <Pill status={i.status} />, width: 95 },
          { key: '_act', label: '', sort: false, render: (i) => (
            <span style={{ display: 'flex', gap: 6 }}>
              {i.status === 'open' && <button className="btn sm success" onClick={(e) => { e.stopPropagation(); setPayTarget(i); }}>💰 Pay</button>}
              <a className="btn sm" href={`/api/invoices/${i.id}/pdf`} onClick={(e) => e.stopPropagation()} target="_blank" rel="noreferrer">⬇ PDF</a>
              {i.status === 'open' && ['admin', 'finance'].includes(user.role) && <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); voidInv(i); }}>Void</button>}
            </span>
          ) },
        ]}
      />

      {payTarget && (
        <Modal title={`Register payment — ${payTarget.number}`} onClose={() => setPayTarget(null)}
          footer={<><button className="btn" onClick={() => setPayTarget(null)}>Cancel</button><button className="btn success" onClick={doPay}>Record payment</button></>}>
          <p style={{ marginTop: 0 }}>{payTarget.customer_name} · <b>{fmtMoney(payTarget.amount, payTarget.currency)}</b> · {payTarget.kind}</p>
          <div className="grid2">
            <div className="field"><label className="f">Method</label>
              <select className="f" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="bank_transfer">Bank transfer</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
              </select>
            </div>
            <div className="field"><label className="f">Reference</label><input className="f" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="TXN-…" /></div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Full payment auto-generates the salesperson's commission (rule-matched, margin-tiered).</div>
        </Modal>
      )}
    </>
  );
}
