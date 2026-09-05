/* DealFlow360 — CUSTOMER PORTAL (restricted, separate surface: portal session or per-quote magic link) */
'use strict';
const express = require('express');
const { db } = require('../db');
const { requirePortal } = require('../util');
const E = require('../engines');

const r = express.Router();

/* resolve which quotation the portal caller may see */
function resolveQuote(req, number) {
  if (req.via === 'magic') return req.quote.number === number ? req.quote : null;
  const q = db.prepare('SELECT * FROM quotations WHERE number=?').get(number);
  if (!q) return null;
  return q.customer_id === req.user.customer_id ? q : null; // customers only ever see their own quotes
}
function portalView(q) {
  const lines = db.prepare(`SELECT l.*, p.tax_rate FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE l.quotation_id=? ORDER BY l.sort, l.id`).all(q.id);
  for (const l of lines) {
    l.gross = E.r2(l.qty * l.unit_price);
    l.effective_discount = Math.round(E.effectiveDiscount(l.discount_pct, q.order_discount_pct) * 100) / 100;
    l.net = E.r2(l.gross * (1 - l.effective_discount / 100));
  }
  return {
    number: q.number, status: q.status, currency: q.currency, subtotal: q.subtotal, discount_total: q.discount_total,
    tax_total: q.tax_total, total: q.total, valid_until: q.valid_until, expected_delivery: q.expected_delivery,
    created_at: q.created_at, order_discount_pct: q.order_discount_pct,
    lines,
    negotiations: db.prepare(`SELECT n.*, l.description line_label FROM negotiations n LEFT JOIN quotation_lines l ON l.id=n.line_id
      WHERE n.quotation_id=? AND n.user_id IS NULL OR (n.quotation_id=? AND n.kind='counter') ORDER BY n.id DESC`).all(q.id, q.id),
    thread: db.prepare(`SELECT n.*, l.description line_label, u.name staff_name FROM negotiations n
      LEFT JOIN quotation_lines l ON l.id=n.line_id LEFT JOIN users u ON u.id=n.user_id
      WHERE n.quotation_id=? ORDER BY n.id DESC LIMIT 50`).all(q.id),
    invoices: db.prepare(`SELECT id, number, kind, amount, status, due_date, created_at FROM invoices WHERE quotation_id=? AND status!='void' ORDER BY id`).all(q.id),
    customer: db.prepare('SELECT name, tier FROM customers WHERE id=?').get(q.customer_id),
  };
}

r.get('/portal/quotes', requirePortal, (req, res) => {
  if (req.via === 'magic') return res.status(403).json({ error: 'Magic link is for a single quotation' });
  const rows = db.prepare(`SELECT q.number, q.status, q.total, q.currency, q.created_at, q.valid_until FROM quotations q
    WHERE q.customer_id=? ORDER BY q.id DESC`).all(req.user.customer_id);
  res.json({ quotes: rows });
});

r.get('/portal/quote/:number', requirePortal, (req, res) => {
  const q = resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  res.json({ quote: portalView(q), via: req.via });
});

/* line-level comment or change request */
r.post('/portal/quote/:number/comment', requirePortal, (req, res) => {
  const q = resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const { line_id, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message required' });
  const who = req.user ? req.user.name : 'Customer (portal link)';
  db.prepare(`INSERT INTO negotiations(quotation_id,line_id,user_name,kind,message,status) VALUES(?,?,NULL,'comment',?, 'open')`)
    .run(q.id, line_id || null, message);
  db.prepare(`UPDATE quotations SET status=CASE WHEN status='sent' THEN 'negotiating' ELSE status END, last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.audit('quotation', q.id, null, 'portal_comment', `${who}: ${message}`);
  res.json({ quote: portalView(db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id)) });
});

/* counter discount proposal */
r.post('/portal/quote/:number/counter', requirePortal, (req, res) => {
  const q = resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['sent', 'negotiating'].includes(q.status)) return res.status(400).json({ error: `Quotation is ${q.status} — negotiation is closed` });
  const proposed = Number(req.body?.discount_pct);
  const message = req.body?.message || '';
  if (!(proposed >= 0) || proposed > 90) return res.status(400).json({ error: 'Proposed discount must be 0–90%' });
  const who = req.user ? req.user.name : 'Customer (portal link)';
  db.prepare(`INSERT INTO negotiations(quotation_id,user_name,kind,message,proposed_discount,status) VALUES(?,NULL,'counter',?,?,'open')`)
    .run(q.id, message || `Counter proposal: ${proposed}% discount`, proposed);
  db.prepare(`UPDATE quotations SET status='negotiating', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.audit('quotation', q.id, null, 'portal_counter', `${who} countered at ${proposed}%`);
  res.json({ quote: portalView(db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id)) });
});

/* one-click confirm — re-enters approval automatically if negotiated terms now exceed ceilings */
r.post('/portal/quote/:number/confirm', requirePortal, (req, res) => {
  const q = resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['sent', 'negotiating', 'approved'].includes(q.status)) return res.status(400).json({ error: `Quotation is ${q.status} and cannot be confirmed` });
  // if there is an OPEN counter that the rep has not accepted, confirming accepts it implicitly (negotiated terms)
  const openCounter = db.prepare(`SELECT * FROM negotiations WHERE quotation_id=? AND kind='counter' AND status='open' ORDER BY id DESC LIMIT 1`).get(q.id);
  if (openCounter && openCounter.proposed_discount != null) {
    db.prepare('UPDATE quotation_lines SET discount_pct=? WHERE quotation_id=?').run(openCounter.proposed_discount, q.id);
    db.prepare(`UPDATE quotations SET order_discount_pct=0 WHERE id=?`).run(q.id);
    db.prepare(`UPDATE negotiations SET status='accepted', resolved_at=datetime('now') WHERE id=?`).run(openCounter.id);
  }
  E.recomputeTotals(q.id);
  const fresh = db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id);
  const { level, risk } = E.requiredApprovalLevel(fresh);
  if (level !== 'none') {
    const status = level === 'manager' ? 'pending_manager' : 'pending_finance';
    db.prepare(`UPDATE quotations SET status=?, approval_level=? WHERE id=?`).run(status, level, q.id);
    db.prepare('DELETE FROM approvals WHERE quotation_id=?').run(q.id);
    if (level === 'finance') db.prepare(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,1,'pending')`).run(q.id, 'manager');
    db.prepare(`INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,?,'pending')`).run(q.id, level, level === 'finance' ? 2 : 1);
    E.audit('quotation', q.id, null, 're_entered_approval',
      `Customer confirmed negotiated terms (risk ${risk.risk_score}) — automatically re-routed to ${level}`);
  } else {
    db.prepare(`UPDATE quotations SET status='approved', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
    E.audit('quotation', q.id, null, 'customer_confirmed', `Customer confirmed quotation on portal (terms within limits)`);
  }
  const openComments = db.prepare(`SELECT COUNT(*) c FROM negotiations WHERE quotation_id=? AND status='open'`).get(q.id).c;
  if (openComments) db.prepare(`UPDATE negotiations SET status='accepted', resolved_at=datetime('now') WHERE quotation_id=? AND status='open'`).run(q.id);
  res.json({ quote: portalView(db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id)), re_approval: level });
});

module.exports = r;
