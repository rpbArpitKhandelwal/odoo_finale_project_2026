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
  db.prepare(`DELETE FROM fulfillment_splits WHERE quotation_id=? AND status IN ("planned")`).run(q.id);
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


module.exports = r;
