import React, { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import ListView from '../components/ListView';
import { Pill, Avatar, useToast } from '../components/ui';
import { useAuth } from '../auth';

/* ============================================================ USERS */
export function Users() {
  const { toast } = useToast();
  const [users, setUsers] = useState(null);
  const load = () => api.get('/users').then((r) => setUsers(r.users)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!users) return <div className="page-loading">Loading users…</div>;

  const upd = async (u, patch) => {
    try { await api.put(`/users/${u.id}`, patch); toast('User updated', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="breadcrumbs">Configuration <b>Users</b></div>
      <div className="ctrl-bar"><span className="page-title"><b>{users.length} users</b> — roles drive approval rights</span></div>
      <ListView
        rows={users}
        searchKeys={['name', 'email', 'role', 'sales_team']}
        columns={[
          { key: 'name', label: 'User', link: true, render: (u) => <><Avatar name={u.name} size={24} />{u.name}</> },
          { key: 'email', label: 'Email' },
          { key: 'role', label: 'Role', render: (u) => (
            <select className="f" style={{ width: 130 }} value={u.role} onChange={(e) => upd(u, { role: e.target.value })}>
              {['admin', 'manager', 'finance', 'salesrep', 'customer'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          ) },
          { key: 'sales_team', label: 'Team', render: (u) => (
            <select className="f" style={{ width: 120 }} value={u.sales_team || 'Direct'} onChange={(e) => upd(u, { sales_team: e.target.value })}>
              {['Enterprise', 'SMB', 'Finance', 'Direct'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          ) },
          { key: 'active', label: 'Status', render: (u) => <Pill status={u.active ? 'fulfilled' : 'cancelled'} label={u.active ? 'active' : 'disabled'} /> },
          { key: '_act', label: '', sort: false, render: (u) => (
            <button className="btn sm" onClick={() => upd(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>
          ) },
        ]}
      />
    </>
  );
}

/* ============================================================ SETTINGS */
export function SettingsPage() {
  const { toast } = useToast();
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState(null);
  const load = () => api.get('/settings').then((r) => setS(r.settings)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!s) return <div className="page-loading">Loading settings…</div>;
  const cur = draft || s;
  const set = (k, v) => setDraft({ ...cur, [k]: v });
  const save = async () => {
    try { await api.put('/settings', cur); toast('Settings saved', 'ok'); setDraft(null); load(); } catch (e) { toast(e.message, 'err'); }
  };

  const NUMS = [
    ['stalled_days', 'Stalled-deal threshold (days)', 'Quotations with no activity for this long raise a stalled alert'],
    ['anomaly_multiplier', 'Discount anomaly multiplier', 'Flag confirmed deals whose discount exceeds the rep baseline × this factor'],
    ['slippage_days', 'Delivery slippage grace (days)', 'Past-due orders with open fulfillment raise a slippage alert'],
    ['usd_inr', 'USD→INR rate', 'Applied to bronze-tier INR quotations'],
    ['min_margin_pct', 'Upsell margin floor (%)', 'Suggestions below this product margin never surface'],
    ['base_ship_cost', 'Base shipment cost ($)', 'Per-warehouse shipment baseline × freight weight'],
  ];
  const TEXTS = [['company_name', 'Company name', 'Shown on exports']];

  return (
    <>
      <div className="breadcrumbs">Configuration <b>Settings</b></div>
      <div className="settings-section">
        <h2>Deal health & engines</h2>
        <div className="desc">These thresholds drive the risk router, upsell guard, and deal-health monitors in real time.</div>
        {NUMS.map(([k, label, hint]) => (
          <div className="setting-row" key={k}>
            <div className="lbl"><b>{label}</b><span>{hint}</span></div>
            <div className="ctl"><input className="f" type="number" step="any" value={cur[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
          </div>
        ))}
        {TEXTS.map(([k, label, hint]) => (
          <div className="setting-row" key={k}>
            <div className="lbl"><b>{label}</b><span>{hint}</span></div>
            <div className="ctl"><input className="f" value={cur[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
          </div>
        ))}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!draft} onClick={save}>Save changes</button>
          {draft && <button className="btn" onClick={() => setDraft(null)}>Discard</button>}
        </div>
      </div>
      <div className="settings-section">
        <h2>Demo data</h2>
        <div className="setting-row">
          <div className="lbl"><b>Reset demo dataset</b><span>Drops everything and reseeds the deterministic demo company (~270 quotations). Everyone is signed out.</span></div>
          <div className="ctl">
            <button className="btn danger" onClick={async () => {
              if (!confirm('Reset ALL data to the pristine demo dataset? Every user will be signed out.')) return;
              try { await api.post('/admin/reset-demo', {}); toast('Demo data reset — sign in again', 'ok'); setTimeout(() => { window.location.hash = '#/login'; window.location.reload(); }, 800); }
              catch (e) { toast(e.message, 'err'); }
            }}>↺ Reset demo data</button>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <h2>System</h2>
        <div className="setting-row"><div className="lbl"><b>Stack</b><span>Node.js + Express · PostgreSQL · React (Vite)</span></div></div>
        <div className="setting-row"><div className="lbl"><b>Engines</b><span>Blended-risk approval routing · margin-guarded upsell · greedy warehouse splitting · daily proration · commission rule engine</span></div></div>
      </div>
    </>
  );
}

/* ============================================================ AUDIT LOG */
export function AuditLog() {
  const [entries, setEntries] = useState(null);
  const [entity, setEntity] = useState('');
  useEffect(() => {
    api.get(`/audit?limit=300`).then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, []);
  if (!entries) return <div className="page-loading">Loading audit trail…</div>;
  const rows = entity ? entries.filter((e) => e.entity === entity) : entries;
  const entities = [...new Set(entries.map((e) => e.entity))];

  return (
    <>
      <div className="breadcrumbs">Configuration <b>Audit Log</b></div>
      <div className="ctrl-bar">
        <span className="page-title"><b>{rows.length} entries</b></span>
        <div style={{ flex: 1 }} />
        <select className="f" style={{ width: 150 }} value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">All entities</option>
          {entities.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      <div className="card pad">
        <div className="timeline">
          {rows.slice(0, 120).map((e) => (
            <div className="tl-item" key={e.id}>
              <b style={{ fontSize: 13, textTransform: 'capitalize' }}>{e.action.replace(/_/g, ' ')}</b>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {e.entity}#{e.entity_id}</span>
              <div style={{ fontSize: 12.5 }}>{e.details}</div>
              <div className="when">{e.user_name} · {fmtDateTime(e.created_at)}</div>
            </div>
          ))}
          {!rows.length && <div className="empty-state">No audit entries</div>}
        </div>
      </div>
    </>
  );
}
