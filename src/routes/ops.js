/* DealFlow360 — fulfillment (warehouse split/backorder) + billing (subscriptions, proration, credit notes, payments) */
'use strict';
const express = require('express');
const { db, getSetting } = require('../db');
const { requireInternal, requireRole } = require('../util');
const E = require('../engines');

const r = express.Router();

/* ================= FULFILLMENT ================= */

r.get('/quotations/:id/split-suggestion', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['approved', 'confirmed', 'fulfilling'].includes(q.status)) return res.status(400).json({ error: 'Fulfillment planning starts once the quotation is approved/confirmed' });
  res.json({ suggestion: E.suggestSplit(q.id) });
});

r.post('/quotations/:id/split/accept', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.status !== 'approved') return res.status(400).json({ error: 'Accept the suggested split while the order is approved' });
  const s = E.suggestSplit(q.id);
  db.prepare(`DELETE FROM fulfillment_splits WHERE quotation_id=? AND status='planned'`).run(q.id);
  for (const l of s.lines) {
    db.prepare(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,?,?)`)
      .run(q.id, l.line_id, l.warehouse_id, l.qty, l.status, l.status === 'planned' ? s.est_cost / Math.max(1, s.shipment_count) : 0);
  }
  db.prepare(`UPDATE quotations SET status='confirmed', confirmed_at=COALESCE(confirmed_at, datetime('now')), last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.generateBillingOnConfirm(q.id);
  E.audit('quotation', q.id, req.user, 'split_accepted',
    `Order confirmed. ${s.shipment_count} shipment(s), est. cost ${s.est_cost}${s.per_warehouse.some(w => w.backorder > 0) ? ', remainder backordered' : ''}`);
  res.json({ quotation: qDetail(q.id) });
});

r.post('/quotations/:id/split/override', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.status !== 'approved') return res.status(400).json({ error: 'Override the split while the order is approved' });
  const rows = req.body?.splits || []; // [{line_id, warehouse_id, qty}]
  if (!rows.length) return res.status(400).json({ error: 'Provide splits[]' });
  db.prepare(`DELETE FROM fulfillment_splits WHERE quotation_id=? AND status='planned'`).run(q.id);
  const usedWH = new Set();
  for (const row of rows) {
    db.prepare(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,?,0)`)
      .run(q.id, row.line_id, row.warehouse_id, row.qty, row.status || 'planned');
    if ((row.status || 'planned') === 'planned') usedWH.add(row.warehouse_id);
  }
  db.prepare(`UPDATE quotations SET status='confirmed', confirmed_at=COALESCE(confirmed_at, datetime('now')), last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.generateBillingOnConfirm(q.id);
  E.audit('quotation', q.id, req.user, 'split_overridden', `Manual split: ${rows.length} allocation line(s) across ${usedWH.size} warehouse(s)`);
  res.json({ quotation: qDetail(q.id) });
});

r.post('/quotations/:id/ship', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const splitId = Number(req.body?.split_id);
  const fs = db.prepare(`SELECT * FROM fulfillment_splits WHERE id=? AND quotation_id=? AND status='planned'`).get(splitId, q.id);
  if (!fs) return res.status(400).json({ error: 'That allocation is not shippable' });
  const stock = db.prepare('SELECT qty FROM stock_levels WHERE warehouse_id=? AND product_id=?').get(fs.warehouse_id, lineProduct(fs.line_id));
  const line = db.prepare('SELECT * FROM quotation_lines WHERE id=?').get(fs.line_id);
  if (stock && stock.qty < fs.qty) return res.status(400).json({ error: `Not enough stock in that warehouse (have ${stock.qty}, need ${fs.qty})` });
  if (stock) db.prepare('UPDATE stock_levels SET qty=qty-? WHERE warehouse_id=? AND product_id=?').run(fs.qty, fs.warehouse_id, line.product_id);
  db.prepare(`UPDATE fulfillment_splits SET status='shipped', shipped_at=datetime('now') WHERE id=?`).run(fs.id);
  const remaining = db.prepare(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`).get(q.id).c;
  if (remaining === 0) db.prepare(`UPDATE quotations SET status='fulfilled', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  else db.prepare(`UPDATE quotations SET status='fulfilling', last_activity_at=datetime('now') WHERE id=?`).run(q.id);
  E.audit('quotation', q.id, req.user, 'shipped', `Shipped ${fs.qty} × ${line.description}`);
  res.json({ quotation: qDetail(q.id) });
});

/* consolidate remaining backorder after restock */
r.post('/quotations/:id/consolidate', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const backs = db.prepare(`SELECT fs.*, l.product_id, l.description FROM fulfillment_splits fs
    JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? AND fs.status='backorder'`).all(q.id);
  if (!backs.length) return res.status(400).json({ error: 'No backorder to consolidate' });
  let moved = 0;
  for (const b of backs) {
    let remaining = b.qty;
    const whs = db.prepare(`SELECT * FROM stock_levels WHERE product_id=? AND qty>0 ORDER BY qty DESC`).all(b.product_id);
    for (const wh of whs) {
      if (remaining <= 0) break;
      const take = Math.min(wh.qty, remaining);
      db.prepare('UPDATE stock_levels SET qty=qty-? WHERE id=?').run(take, wh.id);
      db.prepare(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,'planned',0)`)
        .run(q.id, b.line_id, wh.warehouse_id, take);
      remaining -= take; moved += take;
    }
    db.prepare(`UPDATE fulfillment_splits SET qty=? WHERE id=?`).run(remaining, b.id);
    if (remaining === 0) db.prepare(`DELETE FROM fulfillment_splits WHERE id=?`).run(b.id);
  }
  E.audit('quotation', q.id, req.user, 'backorder_consolidated', `New stock arrived — consolidated ${moved} backordered unit(s) into planned shipments`);
  const remainingAll = db.prepare(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`).get(q.id).c;
  if (remainingAll === 0) db.prepare(`UPDATE quotations SET status='fulfilled' WHERE id=?`).run(q.id);
  res.json({ quotation: qDetail(q.id), moved });
});

function lineProduct(lineId) {
  return db.prepare('SELECT product_id FROM quotation_lines WHERE id=?').get(lineId)?.product_id;
}
function qDetail(id) {
  const q = db.prepare(`SELECT q.*, c.name customer_name, u.name rep_name FROM quotations q
    JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id WHERE q.id=?`).get(id);
  if (q) {
    q.can_consolidate = E.canConsolidate(q.id);
    q.fulfillment = db.prepare(`SELECT fs.*, w.name warehouse_name, l.description FROM fulfillment_splits fs
      JOIN warehouses w ON w.id=fs.warehouse_id JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? ORDER BY fs.id`).all(id);
  }
  return q;
}

/* ================= BILLING ================= */

r.get('/invoices', requireInternal, (req, res) => {
  const rows = db.prepare(`SELECT i.*, q.number quote_number, c.name customer_name FROM invoices i
    JOIN quotations q ON q.id=i.quotation_id JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC`).all();
  const pays = db.prepare(`SELECT p.*, i.number invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id ORDER BY p.id DESC`).all();
  res.json({ invoices: rows, payments: pays });
});

r.post('/invoices/:id/pay', requireInternal, (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'open') return res.status(400).json({ error: `Invoice is ${inv.status}` });
  const amount = Number(req.body?.amount ?? inv.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  db.prepare('INSERT INTO payments(invoice_id,amount,method,reference) VALUES(?,?,?,?)')
    .run(inv.id, amount, req.body?.method || 'bank_transfer', req.body?.reference || '');
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?').get(inv.id).s;
  if (paid >= inv.amount - 0.01) {
    db.prepare(`UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE id=?`).run(inv.id);
  }
  E.audit('invoice', inv.id, req.user, 'payment_recorded', `${inv.number}: ${amount} (${req.body?.method || 'bank_transfer'}) → ${paid >= inv.amount - 0.01 ? 'PAID' : 'partial'}`);
  res.json({ invoice: db.prepare('SELECT * FROM invoices WHERE id=?').get(inv.id) });
});

r.post('/invoices/:id/void', requireRole('admin', 'finance'), (req, res) => {
  db.prepare(`UPDATE invoices SET status='void' WHERE id=? AND status='open'`).run(Number(req.params.id));
  E.audit('invoice', Number(req.params.id), req.user, 'voided', '');
  res.json({ ok: true });
});

/* generate due recurring invoices for a quotation */
r.post('/quotations/:id/billing/generate', requireInternal, (req, res) => {
  const created = E.generateDueInvoices(Number(req.params.id));
  if (created) E.audit('quotation', Number(req.params.id), req.user, 'recurring_invoices_generated', `${created} due cycle(s) invoiced`);
  res.json({ created });
});

/* mid-cycle subscription quantity change → prorated adjustment */
r.post('/quotations/:id/lines/:lineId/subscription', requireInternal, (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(Number(req.params.id));
  const line = db.prepare(`SELECT l.* FROM quotation_lines l WHERE l.id=? AND l.quotation_id=?`).get(Number(req.params.lineId), q?.id);
  if (!q || !line) return res.status(404).json({ error: 'Line not found' });
  if (line.line_type !== 'subscription') return res.status(400).json({ error: 'Not a subscription line' });
  const action = req.body?.action; // modify | cancel
  if (action === 'modify') {
    const newQty = Number(req.body?.qty);
    if (!newQty || newQty <= 0) return res.status(400).json({ error: 'qty required' });
    const pr = E.prorateLineChange(line, newQty);
    db.prepare('UPDATE quotation_lines SET qty=? WHERE id=?').run(newQty, line.id);
    E.recomputeTotals(q.id);
    // adjust future schedule entries
    const price = line.unit_price * (1 - E.effectiveDiscount(line.discount_pct, q.order_discount_pct) / 100);
    db.prepare(`UPDATE billing_schedule SET amount=? WHERE line_id=? AND status='scheduled'`).run(E.r2(newQty * price), line.id);
    if (pr && pr.delta !== 0) {
      const kind = pr.delta > 0 ? 'recurring' : 'credit_note';
      const inv = db.prepare(`INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,date('now'))`)
        .run(E.nextInvoiceNumber(), q.id, q.customer_id, kind, Math.abs(pr.delta), 'open');
      E.audit('quotation', q.id, req.user, 'subscription_modified',
        `${line.description}: qty ${line.qty}→${newQty}, daily proration (${pr.days_remaining}/${pr.days_in_cycle} days) → ${kind === 'credit_note' ? 'credit note' : 'charge'} ${Math.abs(pr.delta)} (INV row ${Number(inv.lastInsertRowid)})`);
    } else {
      E.audit('quotation', q.id, req.user, 'subscription_modified', `${line.description}: qty ${line.qty}→${newQty} (no prorated delta)`);
    }
  } else if (action === 'cancel') {
    const active = db.prepare(`SELECT COUNT(*) c FROM billing_schedule WHERE line_id=? AND status='scheduled'`).get(line.id).c;
    if (!active) return res.status(400).json({ error: 'No active cycles remain on this subscription' });
    const cr = E.cancelSubscriptionCredit(line);
    db.prepare(`UPDATE billing_schedule SET status='cancelled' WHERE line_id=? AND status='scheduled'`).run(line.id);
    if (cr.refund > 0) {
      db.prepare(`INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,date('now'))`)
        .run(E.nextInvoiceNumber(), q.id, q.customer_id, 'credit_note', cr.refund, 'open');
    }
    E.audit('quotation', q.id, req.user, 'subscription_cancelled',
      `${line.description} cancelled (policy: ${cr.policy}) → credit note ${cr.refund}`);
  } else return res.status(400).json({ error: 'action must be modify|cancel' });
  const fresh = db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id);
  const out = { quotation: fresh };
  out.schedule = db.prepare(`SELECT bs.*, l.description FROM billing_schedule bs LEFT JOIN quotation_lines l ON l.id=bs.line_id WHERE bs.quotation_id=? ORDER BY bs.scheduled_date`).all(q.id);
  out.invoices = db.prepare('SELECT * FROM invoices WHERE quotation_id=? ORDER BY id').all(q.id);
  res.json(out);
});

module.exports = r;
