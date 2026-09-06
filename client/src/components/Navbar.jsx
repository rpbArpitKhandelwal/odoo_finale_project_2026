import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { api } from '../api';
import { Avatar, useToast } from './ui';
import Logo from './Logo';

export default function Navbar() {
  const { user, login, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const barRef = useRef(null);
  const role = user?.role;
  const alertCount = alerts.length;

  useEffect(() => { setOpen(null); setUserMenu(false); setBellOpen(false); }, [loc.pathname]);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/dashboard')
      .then((r) => alive && setAlerts(r.kpi.alerts || []))
      .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [loc.pathname]);

  const go = (path) => {
    setOpen(null);
    setUserMenu(false);
    setBellOpen(false);
    nav(path);
  };

  const switchPersona = async (email, password, label) => {
    try {
      await login(email, password);
      toast(`Switched to ${label}`, 'ok');
      setUserMenu(false);
      nav('/');
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const menus = [
    {
      label: 'Orders',
      items: [
        { label: 'Quotations', path: '/quotations' },
        { label: 'Pipeline (Kanban)', path: '/pipeline' },
        { label: 'Orders', path: '/orders' },
        { label: 'Customers', path: '/customers' },
        { label: 'Invoices & Billing', path: '/invoices' },
      ],
    },
    {
      label: 'Products',
      items: [
        { label: 'Products', path: '/products' },
        { label: 'Pricelists', path: '/pricelists' },
        { label: 'Discount Governance', path: '/governance' },
        { label: 'Subscription Plans', path: '/plans' },
        { label: 'Upsell Rules', path: '/upsell' },
      ],
    },
    {
      label: 'Commissions',
      items: [
        { label: 'Commissions', path: '/commissions' },
        { label: 'Commission Rules', path: '/commissions/rules' },
        { label: 'Commissions by Salesperson', path: '/commissions/report' },
        { label: 'Sales Commission Detail', path: '/commissions/report?view=detail' },
      ],
    },
    {
      label: 'Reporting',
      items: [
        { label: 'Sales Analytics', path: '/reports' },
        { label: 'Dashboards', path: '/' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { label: 'Warehouses & Stock', path: '/warehouses' },
        { label: 'Users & RBAC', path: '/users' },
        { label: 'Settings & Policies', path: '/settings' },
        { label: 'Audit Log', path: '/audit' },
      ],
    },
  ];

  return (
    <div className="navbar" ref={barRef}>
      <div className="brand" onClick={() => go('/')} style={{ cursor: 'pointer' }}>
        <Logo size={28} textSize={16} variant="light" />
      </div>
      <div className="nav-menus">
        {menus.map((m) => (
          <div key={m.label} className={`nav-item ${open === m.label ? 'open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpen(open === m.label ? null : m.label); setBellOpen(false); setUserMenu(false); }}>
            <span className="txt">{m.label}</span><span className="nav-caret" style={{ fontSize: 10, marginLeft: 4 }}>▼</span>
            <div className="dropdown">
              {m.items.map((it) => (
                <a key={it.path} onClick={(e) => { e.preventDefault(); go(it.path); }}>{it.label}</a>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="nav-right">
        <button
          className="btn sm"
          style={{ background: 'rgba(255,255,255,0.18)', color: '#FFF', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4, cursor: 'pointer', padding: '4px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
          onClick={() => window.open('/#/portal', '_blank')}
          title="Open the customer-facing portal (separate restricted surface) in a new tab">
          <span>🌐</span> Customer Portal ↗
        </button>

        {/* notifications bell — dropdown with the live deal-health alerts */}
        <div className="nav-bell" title="Deal health alerts" style={{ cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); setBellOpen(!bellOpen); setUserMenu(false); setOpen(null); }}>
          <span>🔔</span>{alertCount > 0 && <span className="badge">{alertCount}</span>}
          {bellOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 300 }} onClick={(e) => { e.stopPropagation(); setBellOpen(false); }} />
              <div className="dropdown dd-open" style={{ right: 6, left: 'auto', top: '100%', minWidth: 320, zIndex: 301 }}>
                <div style={{ padding: '9px 14px', borderBottom: '1px solid #F3F4F6', fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Deal health alerts</span><span>{alertCount} open</span>
                </div>
                {alerts.length === 0 && (
                  <div style={{ padding: '16px 14px', color: '#6B7280', fontSize: 12.5, textAlign: 'center' }}>✅ All deals healthy</div>
                )}
                {alerts.slice(0, 6).map((a) => (
                  <a key={a.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 14px', borderBottom: '1px solid #F8F9FA' }}
                    onClick={(e) => { e.preventDefault(); go(`/quotations/${a.quotation_id}`); }}>
                    <span className={`alert-ico sev-${a.severity}`} style={{ width: 26, height: 26, fontSize: 13 }}>
                      {a.kind === 'stalled' ? '⏳' : a.kind === 'anomaly' ? '📉' : a.kind === 'backorder' ? '📦' : '🚚'}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, color: '#1F2328', whiteSpace: 'normal', lineHeight: 1.35 }}>{a.message}</span>
                      <span style={{ fontSize: 11, color: '#9CA3AF' }}>{a.kind.toUpperCase()} · click to open →</span>
                    </span>
                  </a>
                ))}
                <a style={{ padding: '9px 14px', fontWeight: 600, color: '#714B67', justifyContent: 'center' }}
                  onClick={(e) => { e.preventDefault(); go('/'); }}>View full dashboard →</a>
              </div>
            </>
          )}
        </div>

        <div className="nav-user" onClick={() => { setUserMenu(!userMenu); setBellOpen(false); setOpen(null); }} style={{ cursor: 'pointer' }}>
          <span className="avatar"><Avatar name={user?.name} size={27} /></span>
          <span className="who txt">
            <div>{user?.name || 'User'}</div>
            <div className="role">{role === 'salesrep' ? 'Salesperson' : role || 'User'}</div>
          </span>
          <span className="nav-caret" style={{ fontSize: 9, marginLeft: 2, opacity: 0.7 }}>▼</span>
          {userMenu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 300 }} onClick={(e) => { e.stopPropagation(); setUserMenu(false); }} />
              <div className="dropdown dd-open" style={{ right: 6, left: 'auto', top: '100%', minWidth: 225 }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid #F3F4F6', fontSize: 11, color: '#6B7280', textTransform: 'uppercase', fontWeight: 700 }}>
                  Switch Role Persona
                </div>
                <a onClick={(e) => { e.preventDefault(); switchPersona('rep@dealflow.io', 'Rep@123', 'Gangadhar (Sales Rep)'); }}>
                  💼 <b>Gangadhar</b> <span className="persona-role">(Rep)</span>
                </a>
                <a onClick={(e) => { e.preventDefault(); switchPersona('manager@dealflow.io', 'Manager@123', 'Achintya Rai (Manager)'); }}>
                  👔 <b>Achintya Rai</b> <span className="persona-role">(Manager)</span>
                </a>
                <a onClick={(e) => { e.preventDefault(); switchPersona('finance@dealflow.io', 'Finance@123', 'Arpit Khandelwal (Finance)'); }}>
                  📊 <b>Arpit Khandelwal</b> <span className="persona-role">(Finance)</span>
                </a>
                <a onClick={(e) => { e.preventDefault(); switchPersona('admin@dealflow.io', 'Admin@123', 'System Admin'); }}>
                  ⚙️ <b>System Admin</b>
                </a>
                <div className="dd-sep" />
                <a style={{ color: '#714B67', fontWeight: 600 }} onClick={(e) => { e.preventDefault(); window.open('/#/portal', '_blank'); }}>
                  🌐 Customer Portal (new tab)
                </a>
                <a style={{ color: '#DC2626' }} onClick={(e) => { e.preventDefault(); logout().then(() => nav('/login')); }}>
                  🚪 Log out
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
