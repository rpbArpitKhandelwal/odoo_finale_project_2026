import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import ListView from '../components/ListView';
import { Pill, Avatar, Modal, useToast } from '../components/ui';
import { useAuth } from '../auth';

export default function Customers() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [customers, setCustomers] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const canEdit = ['admin', 'manager'].includes(user.role);

  const load = () => {
    api.get('/customers').then((r) => setCustomers(r.customers)).catch((e) => toast(e.message, 'err'));
    api.get('/quotations').then((r) => setQuotes(r.quotations)).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  if (!customers) return <div className="page-loading">Loading customers…</div>;

  return (
    <>
      <div className="kpi-chips">
        <div className="kpi-chip" style={{ background: '#B8912F' }}><span className="cnt">{customers.filter((c) => c.tier === 'gold').length}</span> Gold</div>
        <div className="kpi-chip" style={{ background: '#8C9BAB' }}><span className="cnt">{customers.filter((c) => c.tier === 'silver').length}</span> Silver</div>
        <div className="kpi-chip" style={{ background: '#A5713C' }}><span className="cnt">{customers.filter((c) => c.tier === 'bronze').length}</span> Bronze</div>
      </div>
      <ListView
        rows={customers}
        searchKeys={['name', 'email', 'tier', 'address']}
        actions={canEdit && <button className="btn-new" onClick={() => setShowNew(true)}>＋ New</button>}
        columns={[
          { key: 'name', label: 'Customer', link: true, render: (c) => <><Avatar name={c.name} size={24} />{c.name}</> },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone', width: 140 },
          { key: 'tier', label: 'Tier', render: (c) => <Pill status={`tier-${c.tier}`} label={c.tier} /> },
          { key: 'currency', label: 'Currency', width: 90 },
          { key: 'orders', label: 'Orders', num: true, sort: false, render: (c) => quotes.filter((q) => q.customer_id === c.id).length },
          { key: 'won', label: 'Won value (USD eq.)', num: true, sort: false, render: (c) => fmtMoney(quotes.filter((q) => q.customer_id === c.id && ['confirmed', 'fulfilling', 'fulfilled'].includes(q.status)).reduce((s, q) => s + q.total / (q.exchange_rate || 1), 0)) },
          { key: 'created_at', label: 'Since', render: (c) => fmtDate(c.created_at) },
        ]}
      />
      {showNew && <NewCustomer onClose={() => setShowNew(false)} reload={load} />}
    </>
  );
}

function NewCustomer({ onClose, reload }) {
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', email: '', phone: '', tier: 'silver', currency: 'USD', address: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try { await api.post('/customers', f); toast('Customer created', 'ok'); reload(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="New customer" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name} onClick={save}>Create</button></>}>
      <div className="grid2">
        <div className="field"><label className="f">Name</label><input className="f" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label className="f">Email</label><input className="f" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
      </div>
      <div className="grid3">
        <div className="field"><label className="f">Tier</label>
          <select className="f" value={f.tier} onChange={(e) => set('tier', e.target.value)}><option>gold</option><option>silver</option><option>bronze</option></select>
        </div>
        <div className="field"><label className="f">Currency</label>
          <select className="f" value={f.currency} onChange={(e) => set('currency', e.target.value)}><option>USD</option><option>INR</option></select>
        </div>
        <div className="field"><label className="f">Phone</label><input className="f" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
      </div>
      <div className="field"><label className="f">Address</label><input className="f" value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
    </Modal>
  );
}
