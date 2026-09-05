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

/* ---- lines CRUD (builder) ---- */
r.post('/quotations/:id/lines', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'returned', 'negotiating', 'sent'].includes(q.status)) return res.status(400).json({ error: `Lines are locked while status is ${q.status}` });
  const { product_id, variant_id, qty, discount_pct, plan_id } = req.body || {};
  const product = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(product_id);
  if (!product) return res.status(400).json({ error: 'Product not found' });
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(q.customer_id);
  const unit_price = E.unitPriceFor(product_id, variant_id || null, customer);
  let plan = null, period = null, lineType = product.product_type;
  if (product.product_type === 'subscription') {
    plan = plan_id ? db.prepare('SELECT * FROM subscription_plans WHERE id=?').get(plan_id) : db.prepare('SELECT * FROM product_plans pp JOIN subscription_plans sp ON sp.id=pp.plan_id WHERE pp.product_id=?').get(product_id);
    period = plan ? plan.billing_period : 'monthly';
    if (!plan) return res.status(400).json({ error: 'No subscription plan attached to this product' });
  }
  let desc = product.name;
  if (variant_id) { const v = db.prepare('SELECT * FROM product_variants WHERE id=?').get(variant_id); if (v) desc += ` — ${v.value}`; }
  if (period) desc += ` (${period})`;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM quotation_lines WHERE quotation_id=?').get(q.id).m;
  db.prepare(`INSERT INTO quotation_lines(quotation_id,product_id,variant_id,description,qty,unit_price,cost_price,discount_pct,line_type,plan_id,billing_period,sort)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(q.id, product_id, variant_id || null, desc, qty || 1, unit_price, product.cost_price, discount_pct || 0, lineType, plan ? plan.id : null, period, maxSort + 1);
  E.audit('quotation', q.id, req.user, 'line_added', `+${qty || 1} × ${desc}`);
  const updated = E.recomputeTotals(q.id);
  res.json({ quotation: quoteDetail(q.id) });
});

r.put('/quotations/:id/lines/:lineId', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'returned', 'negotiating', 'sent'].includes(q.status)) return res.status(400).json({ error: `Lines are locked while status is ${q.status}` });
  const { qty, discount_pct, unit_price } = req.body || {};
  db.prepare('UPDATE quotation_lines SET qty=COALESCE(?,qty), discount_pct=COALESCE(?,discount_pct), unit_price=COALESCE(?,unit_price) WHERE id=? AND quotation_id=?')
    .run(qty, discount_pct, unit_price, req.params.lineId, q.id);
  E.audit('quotation', q.id, req.user, 'line_updated', `line ${req.params.lineId} → qty=${qty ?? '?'}, disc=${discount_pct ?? '?'}%`);
  E.recomputeTotals(q.id);
  res.json({ quotation: quoteDetail(q.id) });
});

r.delete('/quotations/:id/lines/:lineId', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'returned', 'negotiating', 'sent'].includes(q.status)) return res.status(400).json({ error: `Lines are locked while status is ${q.status}` });
  const l = db.prepare('SELECT description FROM quotation_lines WHERE id=?').get(req.params.lineId);
  db.prepare('DELETE FROM quotation_lines WHERE id=? AND quotation_id=?').run(req.params.lineId, q.id);
  if (l) E.audit('quotation', q.id, req.user, 'line_removed', `− ${l.description}`);
  E.recomputeTotals(q.id);
  res.json({ quotation: quoteDetail(q.id) });
});

r.put('/quotations/:id/order-discount', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const pct = Math.max(0, Math.min(Number(req.body?.order_discount_pct || 0), 90));
  db.prepare('UPDATE quotations SET order_discount_pct=? WHERE id=?').run(pct, q.id);
  E.audit('quotation', q.id, req.user, 'order_discount', `order-level discount ${pct}%`);
  E.recomputeTotals(q.id);
  res.json({ quotation: quoteDetail(q.id) });
});

/* ---- upsell panel ---- */
r.get('/quotations/:id/upsell', requireInternal, (req, res) => {
  res.json({ suggestions: E.upsellSuggestions(Number(req.params.id)) });
});
r.post('/quotations/:id/upsell/:productId/add', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'returned', 'negotiating', 'sent'].includes(q.status)) return res.status(400).json({ error: 'Quotation is locked' });
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(q.customer_id);
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.productId));
  if (!product) return res.status(404).json({ error: 'Product not found' });
  let desc = product.name, plan = null, period = null;
  if (product.product_type === 'subscription') {
    plan = db.prepare('SELECT * FROM product_plans pp JOIN subscription_plans sp ON sp.id=pp.plan_id WHERE pp.product_id=?').get(product.id);
    if (!plan) return res.status(400).json({ error: 'No plan attached' });
    period = plan.billing_period; desc += ` (${period})`;
  }
  const unit_price = E.unitPriceFor(product.id, null, customer);
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM quotation_lines WHERE quotation_id=?').get(q.id).m;
  db.prepare(`INSERT INTO quotation_lines(quotation_id,product_id,variant_id,description,qty,unit_price,cost_price,discount_pct,line_type,plan_id,billing_period,sort)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(q.id, product.id, null, desc, 1, unit_price, product.cost_price, 0, product.product_type, plan ? plan.id : null, period, maxSort + 1);
  E.audit('quotation', q.id, req.user, 'upsell_accepted', `accepted suggestion: ${product.name}`);
  E.recomputeTotals(q.id);
  const fresh = quoteDetail(q.id);
  fresh.suggestions = E.upsellSuggestions(q.id);
  res.json({ quotation: fresh });
});

/* ---- submit → auto risk routing ---- */
r.post('/quotations/:id/submit', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['draft', 'returned'].includes(q.status)) return res.status(400).json({ error: `Cannot submit from status ${q.status}` });
  const lines = db.prepare('SELECT COUNT(*) c FROM quotation_lines WHERE quotation_id=?').get(q.id).c;
  if (!lines) return res.status(400).json({ error: 'Add at least one product line first' });
  E.recomputeTotals(q.id);
  const fresh = db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id);
  const { level, risk } = E.requiredApprovalLevel(fresh);
  const up = { submitted_at: new Date().toISOString() };
  if (level === 'none') {
    db.prepare(`UPDATE quotations SET status='approved', approval_level='none', submitted_at=?, last_activity_at=datetime('now') WHERE id=?`).run(up.submitted_at, q.id);
    E.audit('quotation', q.id, req.user, 'auto_approved', `No approval needed (blended risk ${risk.risk_score}) — ready for fulfillment`);
  } else {
    // manager always reviews first; finance joins when the chain requires it
    db.prepare(`UPDATE quotations SET status='pending_manager', approval_level=?, submitted_at=?, last_activity_at=datetime('now') WHERE id=?`).run(level, up.submitted_at, q.id);
    E.routeForApproval(q.id, level);
    E.audit('quotation', q.id, req.user, 'submitted_for_approval',
      `Auto-routed to ${level === 'finance' ? 'Manager → Finance' : 'Sales Manager'} — blended risk ${risk.risk_score}, worst line ${risk.max_violation} pts over ceiling`);
  }
  res.json({ quotation: quoteDetail(q.id) });
});

/* ---- approve / reject / return ---- */
r.post('/quotations/:id/approve', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const action = req.body?.action; // approve | reject | return
  const reason = req.body?.reason || '';
  if (!['approve', 'reject', 'return'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const pending = db.prepare(`SELECT * FROM approvals WHERE quotation_id=? AND status='pending' ORDER BY sequence LIMIT 1`).get(q.id);
  const expectedStatus = pending ? (pending.level === 'manager' ? 'pending_manager' : 'pending_finance') : null;
  if (!pending || q.status !== expectedStatus) return res.status(400).json({ error: 'No approval step currently waiting for you' });
  const roleOk = (pending.level === 'manager' && ['manager', 'admin'].includes(req.user.role)) ||
    (pending.level === 'finance' && ['finance', 'admin'].includes(req.user.role));
  if (!roleOk) return res.status(403).json({ error: `This step must be actioned by ${pending.level === 'manager' ? 'a Sales Manager' : 'Finance'}` });

  const now = new Date().toISOString();
  if (action === 'approve') {
    db.prepare(`UPDATE approvals SET status='approved', approver_id=?, reason=?, decided_at=? WHERE id=?`).run(req.user.id, reason, now, pending.id);
    const next = db.prepare(`SELECT * FROM approvals WHERE quotation_id=? AND status='waiting' ORDER BY sequence LIMIT 1`).get(q.id);
    if (next) {
      db.prepare(`UPDATE approvals SET status='pending' WHERE id=?`).run(next.id);
      db.prepare(`UPDATE quotations SET status=?, last_activity_at=datetime('now') WHERE id=?`).run(next.level === 'manager' ? 'pending_manager' : 'pending_finance', q.id);
      E.audit('quotation', q.id, req.user, 'approved', `${pending.level} approved${reason ? ` — "${reason}"` : ''}; escalated to ${next.level}`);
    } else {
      db.prepare(`UPDATE quotations SET status='approved', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
      E.audit('quotation', q.id, req.user, 'approved', `Fully approved (${pending.level})${reason ? ` — "${reason}"` : ''}`);
    }
  } else if (action === 'reject') {
    db.prepare(`UPDATE approvals SET status='rejected', approver_id=?, reason=?, decided_at=? WHERE id=?`).run(req.user.id, reason, now, pending.id);
    db.prepare(`UPDATE approvals SET status='skipped' WHERE quotation_id=? AND status IN ('waiting','pending') AND id!=?`).run(q.id, pending.id);
    db.prepare(`UPDATE quotations SET status='rejected', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
    E.audit('quotation', q.id, req.user, 'rejected', `${pending.level} rejected — "${reason}"`);
  } else {
    db.prepare(`UPDATE approvals SET status='returned', approver_id=?, reason=?, decided_at=? WHERE id=?`).run(req.user.id, reason, now, pending.id);
    db.prepare(`UPDATE approvals SET status='skipped' WHERE quotation_id=? AND status IN ('waiting','pending') AND id!=?`).run(q.id, pending.id);
    db.prepare(`UPDATE quotations SET status='returned', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
    E.audit('quotation', q.id, req.user, 'returned', `${pending.level} returned for revision — "${reason}"`);
  }
  res.json({ quotation: quoteDetail(q.id) });
});

/* ---- send to customer (portal) ---- */
r.post('/quotations/:id/send', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['approved', 'sent', 'negotiating'].includes(q.status)) return res.status(400).json({ error: 'Only approved quotations can be sent to the customer' });
  db.prepare(`UPDATE quotations SET status='sent', sent_at=COALESCE(sent_at, datetime('now')), last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.audit('quotation', q.id, req.user, 'sent_to_customer', `Portal link issued: /portal/q/${q.number}`);
  const d = quoteDetail(q.id);
  d.portal_link = `http://localhost:${process.env.PORT || 4300}/#${d.portal_url}`;
  res.json({ quotation: d });
});

/* ---- rep handles customer negotiation requests ---- */
r.post('/quotations/:id/negotiation/:nid', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const n = db.prepare('SELECT * FROM negotiations WHERE id=? AND quotation_id=?').get(Number(req.params.nid), q.id);
  if (!n || n.status !== 'open') return res.status(400).json({ error: 'Request already resolved' });
  const action = req.body?.action; // accept | decline
  const now = new Date().toISOString();
  if (action === 'accept') {
    if (n.kind === 'counter' && n.proposed_discount != null) {
      // apply counter discount on every line, then recompute risk → may re-enter approval automatically
      db.prepare('UPDATE quotation_lines SET discount_pct=? WHERE quotation_id=?').run(n.proposed_discount, q.id);
      db.prepare(`UPDATE quotations SET order_discount_pct=0, status='negotiating', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
      E.recomputeTotals(q.id);
      const fresh = db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id);
      const { level, risk } = E.requiredApprovalLevel(fresh);
      db.prepare('UPDATE negotiations SET status=?, resolved_at=? WHERE id=?').run('accepted', now, n.id);
      if (level !== 'none') {
        db.prepare(`UPDATE quotations SET status='pending_manager', approval_level=? WHERE id=?`).run(level, q.id);
        E.routeForApproval(q.id, level);
        E.audit('quotation', q.id, req.user, 're_entered_approval',
          `Accepted counter at ${n.proposed_discount}% → blended risk ${risk.risk_score}; re-routed to ${level} automatically`);
      } else {
        E.audit('quotation', q.id, req.user, 'counter_accepted', `Counter at ${n.proposed_discount}% accepted (within limits)`);
      }
    } else {
      db.prepare('UPDATE negotiations SET status=?, resolved_at=? WHERE id=?').run('accepted', now, n.id);
      E.audit('quotation', q.id, req.user, 'request_accepted', `Accepted customer request: ${n.message}`);
    }
  } else {
    db.prepare('UPDATE negotiations SET status=?, resolved_at=? WHERE id=?').run('declined', now, n.id);
    E.audit('quotation', q.id, req.user, 'request_declined', `Declined customer request: ${n.message}`);
  }
  res.json({ quotation: quoteDetail(q.id) });
});

module.exports = r;
