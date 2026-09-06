/* DealFlow360 client — fetch helper + formatters */

async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON (exports) */ }
  if (!res.ok) {
    const err = new Error((json && json.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}
export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b || {}),
  put: (p, b) => req('PUT', p, b || {}),
  del: (p) => req('DELETE', p),
};

/* ---------- formatters ---------- */
export const fmtMoney = (v, cur) => {
  const n = Number(v || 0);
  const sym = cur === 'INR' ? '₹' : '$';
  return sym + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const fmtMoney0 = (v, cur) => {
  const n = Number(v || 0);
  return (cur === 'INR' ? '₹' : '$') + Math.round(n).toLocaleString('en-US');
};
export const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');
export const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const fmtPct = (v) => `${Number(v || 0).toFixed(1)}%`;
export const initials = (name) => String(name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export const STATUS_COLORS = {
  draft: ['edeff2', '5F6B7A'], pending_manager: ['ffe8cc', 'B3611E'], pending_finance: ['ffe8cc', '8A4A08'],
  approved: ['dcebf7', '2563EB'], sent: ['dbeafe', '1D4ED8'], negotiating: ['fbf0d9', '9C6F07'],
  confirmed: ['dff0d8', '2F7D32'], fulfilling: ['d5ecea', '0F8B8D'], fulfilled: ['c8e6c9', '1B5E20'],
  rejected: ['f5d2d2', 'B3261E'], returned: ['e7ddf0', '6B4E8E'], cancelled: ['eeeeee', '777777'],
  open: ['ffe8cc', 'B3611E'], paid: ['dff0d8', '2F7D32'], void: ['eeeeee', '777'],
  planned: ['dcebf7', '2563EB'], shipped: ['dff0d8', '2F7D32'], backorder: ['f5d2d2', 'B3261E'],
  scheduled: ['edeff2', '5F6B7A'], invoiced: ['dcebf7', '2563EB'],
  stall: ['ffe8cc', 'B3611E'], info: ['edeff2', '5F6B7A'], accepted: ['dff0d8', '2F7D32'], declined: ['f5d2d2', 'B3261E'],
  'tier-gold': ['fdf1c7', '8a6d00'], 'tier-silver': ['e9ecf1', '4b5563'], 'tier-bronze': ['f3e3d3', '8b4a12'],
};
export const STATUS_LABELS = {
  pending_manager: 'To Approve (Manager)', pending_finance: 'To Approve (Finance)',
  draft: 'Draft', approved: 'Approved', sent: 'Sent', negotiating: 'Negotiating',
  confirmed: 'Confirmed', fulfilling: 'Fulfilling', fulfilled: 'Fulfilled', rejected: 'Rejected',
  returned: 'Returned', cancelled: 'Cancelled', credit_note: 'Credit Note',
};
export const statusLabel = (s) => STATUS_LABELS[s] || String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
