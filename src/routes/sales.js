/* DealFlow360 — quotations lifecycle: build, risk routing, approvals, upsell, negotiation */
'use strict';
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireInternal, requireRole } = require('../util');
const E = require('../engines');

const r = express.Router();
const QUOTE_STATUSES = ['draft', 'pending_manager', 'pending_finance', 'approved', 'returned', 'sent', 'negotiating', 'confirmed', 'fulfilling', 'fulfilled', 'rejected', 'cancelled'];

function nextQuoteNumber() {
  const row = db.prepare(`SELECT number FROM quotations WHERE number LIKE 'QT-%' ORDER BY CAST(substr(number,4) AS INTEGER) DESC LIMIT 1`).get();
  return `QT-${row ? parseInt(row.number.slice(3), 10) + 1 : 1001}`;
}
function quoteDetail(id) {
  const q = db.prepare(`SELECT q.*, c.name customer_name, c.tier customer_tier, c.currency customer_currency,
    u.name rep_name FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id WHERE q.id=?`).get(id);
  if (!q) return null;
  q.lines = db.prepare(`SELECT l.*, p.product_type, p.tax_rate, p.category_id, c.name category_name, c.discount_ceiling
    FROM quotation_lines l JOIN products p ON p.id=l.product_id JOIN categories c ON c.id=p.category_id
    WHERE l.quotation_id=? ORDER BY l.sort, l.id`).all(id);
  for (const l of q.lines) {
    l.gross = E.r2(l.qty * l.unit_price);
    l.effective_discount = Math.round(E.effectiveDiscount(l.discount_pct, q.order_discount_pct) * 100) / 100;
    l.net = E.r2(l.gross * (1 - l.effective_discount / 100));
    l.allowed_discount = E.allowedDiscountFor(q.customer_tier, l.category_id);
    l.violation = Math.max(0, E.r2(l.effective_discount - l.allowed_discount));
    l.margin_pct = l.net > 0 ? Math.round((l.net - l.qty * l.cost_price) / l.net * 100) : 0;
    if (l.variant_id) { const v = db.prepare('SELECT value FROM product_variants WHERE id=?').get(l.variant_id); l.variant_label = v ? v.value : null; }
  }
  const risk = E.computeRisk(q);
  q.risk = risk;
  q.approvals = db.prepare(`SELECT a.*, u.name approver_name FROM approvals a LEFT JOIN users u ON u.id=a.approver_id
    WHERE a.quotation_id=? ORDER BY a.sequence`).all(id);
  q.audit = db.prepare(`SELECT * FROM audit_log WHERE entity='quotation' AND entity_id=? ORDER BY id DESC`).all(id);
  q.negotiations = db.prepare(`SELECT n.*, l.description line_label FROM negotiations n LEFT JOIN quotation_lines l ON l.id=n.line_id
    WHERE n.quotation_id=? ORDER BY n.id DESC`).all(id);
  q.fulfillment = db.prepare(`SELECT fs.*, w.name warehouse_name, l.description, l.product_id FROM fulfillment_splits fs
    JOIN warehouses w ON w.id=fs.warehouse_id JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? ORDER BY fs.id`).all(id);
  q.invoices = db.prepare('SELECT * FROM invoices WHERE quotation_id=? ORDER BY id').all(id);
  q.schedule = db.prepare(`SELECT bs.*, l.description FROM billing_schedule bs LEFT JOIN quotation_lines l ON l.id=bs.line_id WHERE bs.quotation_id=? ORDER BY bs.scheduled_date`).all(id);
  q.portal_url = `/portal/q/${q.number}?k=${q.portal_token}`;
  return q;
}

/* ---- list (workspace + pipeline) ---- */
r.get('/quotations', requireInternal, (req, res) => {
  const mine = req.query.mine === '1' && req.user.role === 'salesrep';
  const rows = db.prepare(`SELECT q.*, c.name customer_name, u.name rep_name FROM quotations q
    JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id
    ${mine ? 'WHERE q.rep_id=?' : ''} ORDER BY q.id DESC`).all(...(mine ? [req.user.id] : []));
  res.json({ quotations: rows });
});

r.post('/quotations', requireInternal, (req, res) => {
  const { customer_id, expected_delivery } = req.body || {};
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
  if (!customer) return res.status(400).json({ error: 'Valid customer required' });
  const rate = customer.currency === 'INR' ? parseFloat(db.prepare(`SELECT value FROM settings WHERE key='usd_inr'`).get()?.value || 83) : 1;
  const number = nextQuoteNumber();
  const info = db.prepare(`INSERT INTO quotations(number,customer_id,rep_id,status,currency,exchange_rate,valid_until,expected_delivery,portal_token)
    VALUES(?,?,?,'draft',?,?,?,?,?)`)
    .run(number, customer_id, req.user.id, customer.currency, rate,
      new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), expected_delivery || null, crypto.randomBytes(12).toString('hex'));
  const id = Number(info.lastInsertRowid);
  E.audit('quotation', id, req.user, 'created', `${number} for ${customer.name}`);
  res.json({ quotation: quoteDetail(id) });
});

r.get('/quotations/:id', requireInternal, (req, res) => {
  const q = quoteDetail(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  q.can_consolidate = E.canConsolidate(q.id);
  res.json({ quotation: q });
});


module.exports = r;
