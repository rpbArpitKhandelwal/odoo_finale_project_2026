import React, { createContext, useContext, useState } from 'react';
import { STATUS_COLORS, statusLabel, initials } from '../api';

/* ---------- StatusPill ---------- */
export function Pill({ status, label }) {
  const [bg, fg] = STATUS_COLORS[status] || ['EDEFF2', '5F6B7A'];
  return (
    <span className="pill" style={{ background: `#${bg}`, color: `#${fg}` }}>
      <span className="dot" />{label || statusLabel(status)}
    </span>
  );
}

/* ---------- Avatar ---------- */
export function Avatar({ name, size }) {
  const idx = String(name || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 6;
  return (
    <span className="avatar-sm" style={{ width: size || 24, height: size || 24 }}>
      <span className={`avatar-bg${idx}`} style={{ width: '100%', height: '100%', borderRadius: '50%', display: 'grid', placeItems: 'center' }}>
        {initials(name)}
      </span>
    </span>
  );
}

/* ---------- Toasts ---------- */
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = (msg, kind = '') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };
  return (
    <ToastCtx.Provider value={{ toast: push }}>
      {children}
      <div className="toast-wrap">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, wide }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(760px, 94vw)' } : undefined}>
        <div className="m-head">{title}<span className="x" onClick={onClose}>✕</span></div>
        <div className="m-body">{children}</div>
        {footer && <div className="m-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- KPI chip row (list-view counters, Odoo style) ---------- */
export function KpiChips({ chips }) {
  return (
    <div className="kpi-chips">
      {chips.map((c, i) => (
        <div key={i} className="kpi-chip" style={{ background: c.color || '#714B67' }} onClick={c.onClick} title={c.hint || ''}>
          <span className="cnt">{c.count}</span> {c.label}
        </div>
      ))}
    </div>
  );
}

/* ---------- Risk gauge ---------- */
export function RiskBar({ score }) {
  const pct = Math.min(100, (Number(score || 0) / 12) * 100);
  const color = score > 5 ? '#CD3D63' : score > 0.5 ? '#E4A11B' : '#0F7B3D';
  return (
    <div className="risk-wrap">
      <div className="risk-bar"><div className="risk-fill" style={{ width: `${pct}%` }} /></div>
      <b style={{ color }}>{Number(score || 0).toFixed(1)}</b>
    </div>
  );
}

/* ---------- Sparkline-ish meters ---------- */
export function Meter({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div className="meter"><div style={{ width: `${pct}%`, background: color || '#714B67' }} /></div>;
}

/* ---------- Dropdown button ---------- */
export function DropBtn({ label, children, ...rest }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button className={`btn ${rest.className || ''}`} onClick={() => setOpen(!open)} disabled={rest.disabled}>
        {label} <span className="caret">▼</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 250 }} onClick={() => setOpen(false)} />
          <div className="dropdown dd-open" style={{ left: 0, top: '100%', marginTop: 2, minWidth: 200, color: '#1F2328', borderRadius: 6 }}>
            {children}
          </div>
        </>
      )}
    </span>
  );
}
