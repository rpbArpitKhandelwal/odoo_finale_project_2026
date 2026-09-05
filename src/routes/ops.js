/* DealFlow360 — fulfillment (warehouse split/backorder) + billing (subscriptions, proration, credit notes, payments) (PostgreSQL, async) */
'use strict';
const express = require('express');
const { Q, ONE, RUN, NOW_ISO, TODAY } = require('../db');
const { requireInternal, requireRole } = require('../util');
const E = require('../engines');

const r = express.Router();

/* ================= FULFILLMENT ================= */

r.get('/quotations/:id/split-suggestion', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['approved', 'confirmed', 'fulfilling'].includes(q.status)) return res.status(400).json({ error: 'Fulfillment planning starts once the quotation is approved/confirmed' });
  res.json({ suggestion: await E.suggestSplit(q.id) });
});

r.post('/quotations/:id/split/accept', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.status !== 'approved') return res.status(400).json({ error: 'Accept the suggested split while the order is approved' });
  const s = await E.suggestSplit(q.id);
  await RUN(`DELETE FROM fulfillment_splits WHERE quotation_id=? AND status='planned'`, [q.id]);
  for (const l of s.lines) {
    await RUN(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,?,?)`,
      [q.id, l.line_id, l.warehouse_id, l.qty, l.status, l.status === 'planned' ? s.est_cost / Math.max(1, s.shipment_count) : 0]);
  }
  await RUN(`UPDATE quotations SET status='confirmed', confirmed_at=COALESCE(confirmed_at, ${NOW_ISO}), last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  await E.generateBillingOnConfirm(q.id);
  await E.audit('quotation', q.id, req.user, 'split_accepted',
    `Order confirmed. ${s.shipment_count} shipment(s), est. cost ${s.est_cost}${s.per_warehouse.some(w => w.backorder > 0) ? ', remainder backordered' : ''}`);
  res.json({ quotation: await qDetail(q.id) });
});

r.post('/quotations/:id/split/override', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.status !== 'approved') return res.status(400).json({ error: 'Override the split while the order is approved' });
  const rows = req.body?.splits || []; // [{line_id, warehouse_id, qty}]
  if (!rows.length) return res.status(400).json({ error: 'Provide splits[]' });
  await RUN(`DELETE FROM fulfillment_splits WHERE quotation_id=? AND status='planned'`, [q.id]);
  const usedWH = new Set();
  for (const row of rows) {
    await RUN(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,?,0)`,
      [q.id, row.line_id, row.warehouse_id, row.qty, row.status || 'planned']);
    if ((row.status || 'planned') === 'planned') usedWH.add(row.warehouse_id);
  }
  await RUN(`UPDATE quotations SET status='confirmed', confirmed_at=COALESCE(confirmed_at, ${NOW_ISO}), last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  await E.generateBillingOnConfirm(q.id);
  await E.audit('quotation', q.id, req.user, 'split_overridden', `Manual split: ${rows.length} allocation line(s) across ${usedWH.size} warehouse(s)`);
  res.json({ quotation: await qDetail(q.id) });
});

r.post('/quotations/:id/ship', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const splitId = Number(req.body?.split_id);
  const fs = await ONE(`SELECT * FROM fulfillment_splits WHERE id=? AND quotation_id=? AND status='planned'`, [splitId, q.id]);
  if (!fs) return res.status(400).json({ error: 'That allocation is not shippable' });
  const line = await ONE('SELECT * FROM quotation_lines WHERE id=?', [fs.line_id]);
  const stock = await ONE('SELECT qty FROM stock_levels WHERE warehouse_id=? AND product_id=?', [fs.warehouse_id, line.product_id]);
  if (stock && stock.qty < fs.qty) return res.status(400).json({ error: `Not enough stock in that warehouse (have ${stock.qty}, need ${fs.qty})` });
  if (stock) await RUN('UPDATE stock_levels SET qty=qty-? WHERE warehouse_id=? AND product_id=?', [fs.qty, fs.warehouse_id, line.product_id]);
  await RUN(`UPDATE fulfillment_splits SET status='shipped', shipped_at=${NOW_ISO} WHERE id=?`, [fs.id]);
  const remaining = await ONE(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`, [q.id]);
  if (remaining.c === 0) await RUN(`UPDATE quotations SET status='fulfilled', last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  else await RUN(`UPDATE quotations SET status='fulfilling', last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  await E.audit('quotation', q.id, req.user, 'shipped', `Shipped ${fs.qty} × ${line.description}`);
  res.json({ quotation: await qDetail(q.id) });
});

/* consolidate remaining backorder after restock */
r.post('/quotations/:id/consolidate', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const backs = await Q(`SELECT fs.*, l.product_id, l.description FROM fulfillment_splits fs
    JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? AND fs.status='backorder'`, [q.id]);
  if (!backs.length) return res.status(400).json({ error: 'No backorder to consolidate' });
  let moved = 0;
  for (const b of backs) {
    let remaining = b.qty;
    const whs = await Q(`SELECT * FROM stock_levels WHERE product_id=? AND qty>0 ORDER BY qty DESC`, [b.product_id]);
    for (const wh of whs) {
      if (remaining <= 0) break;
      const take = Math.min(wh.qty, remaining);
      await RUN('UPDATE stock_levels SET qty=qty-? WHERE id=?', [take, wh.id]);
      await RUN(`INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost) VALUES(?,?,?,?,'planned',0)`,
        [q.id, b.line_id, wh.warehouse_id, take]);
      remaining -= take; moved += take;
    }
    await RUN(`UPDATE fulfillment_splits SET qty=? WHERE id=?`, [remaining, b.id]);
    if (remaining === 0) await RUN(`DELETE FROM fulfillment_splits WHERE id=?`, [b.id]);
  }
  await E.audit('quotation', q.id, req.user, 'backorder_consolidated', `New stock arrived — consolidated ${moved} backordered unit(s) into planned shipments`);
  const remainingAll = await ONE(`SELECT COUNT(*) c FROM fulfillment_splits WHERE quotation_id=? AND status IN ('planned','backorder')`, [q.id]);
  if (remainingAll.c === 0) await RUN(`UPDATE quotations SET status='fulfilled' WHERE id=?`, [q.id]);
  res.json({ quotation: await qDetail(q.id), moved });
});

async function qDetail(id) {
  const q = await ONE(`SELECT q.*, c.name customer_name, u.name rep_name FROM quotations q
    JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id WHERE q.id=?`, [id]);
  if (q) {
    q.can_consolidate = await E.canConsolidate(q.id);
    q.fulfillment = await Q(`SELECT fs.*, w.name warehouse_name, l.description FROM fulfillment_splits fs
      JOIN warehouses w ON w.id=fs.warehouse_id JOIN quotation_lines l ON l.id=fs.line_id WHERE fs.quotation_id=? ORDER BY fs.id`, [id]);
  }
  return q;
}

/* ================= BILLING ================= */

r.get('/invoices', requireInternal, async (_req, res) => {
  const rows = await Q(`SELECT i.*, q.number quote_number, c.name customer_name FROM invoices i
    JOIN quotations q ON q.id=i.quotation_id JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC`);
  const pays = await Q(`SELECT p.*, i.number invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id ORDER BY p.id DESC`);
  res.json({ invoices: rows, payments: pays });
});

r.post('/invoices/:id/pay', requireInternal, async (req, res) => {
  const inv = await ONE('SELECT * FROM invoices WHERE id=?', [Number(req.params.id)]);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'open') return res.status(400).json({ error: `Invoice is ${inv.status}` });
  const amount = Number(req.body?.amount ?? inv.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
  await RUN('INSERT INTO payments(invoice_id,amount,method,reference) VALUES(?,?,?,?)',
    [inv.id, amount, req.body?.method || 'bank_transfer', req.body?.reference || '']);
  const paid = await ONE('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?', [inv.id]);
  let commissioned = [];
  if (paid.s >= inv.amount - 0.01) {
    await RUN(`UPDATE invoices SET status='paid', paid_at=${NOW_ISO} WHERE id=?`, [inv.id]);
    commissioned = await E.generateCommissionsForInvoice(inv.id, req.user); // commission auto-generates on full payment
  }
  await E.audit('invoice', inv.id, req.user, 'payment_recorded', `${inv.number}: ${amount} (${req.body?.method || 'bank_transfer'}) → ${paid.s >= inv.amount - 0.01 ? 'PAID' : 'partial'}${commissioned.length ? ` · commission ${commissioned[0].number} drafted` : ''}`);
  res.json({ invoice: await ONE('SELECT * FROM invoices WHERE id=?', [inv.id]), commissions: commissioned });
});

r.post('/invoices/:id/void', requireRole('admin', 'finance'), async (req, res) => {
  await RUN(`UPDATE invoices SET status='void' WHERE id=? AND status='open'`, [Number(req.params.id)]);
  await E.audit('invoice', Number(req.params.id), req.user, 'voided', '');
  res.json({ ok: true });
});

/* download a single invoice as PDF (internal) */
r.get('/invoices/:id/pdf', requireInternal, async (req, res) => {
  const out = await invoicePDF(Number(req.params.id));
  if (out.error) return res.status(out.error === 'not found' ? 404 : 400).json({ error: out.error });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.end(out.buffer);
});

/* compose the invoice document — shared by internal + portal download */
async function invoicePDF(invoiceId) {
  const { buildPDF } = require('../exporter');
  const inv = await ONE(`SELECT i.*, q.number quote_number, q.order_discount_pct, q.currency, q.customer_id, q.id qid,
    c.name customer_name, c.tier customer_tier, c.address customer_address
    FROM invoices i JOIN quotations q ON q.id=i.quotation_id JOIN customers c ON c.id=i.customer_id WHERE i.id=?`, [invoiceId]);
  if (!inv) return { error: 'not found' };
  const lines = await Q(`SELECT l.*, p.tax_rate FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE l.quotation_id=? ORDER BY l.sort, l.id`, [inv.qid]);
  const od = inv.order_discount_pct || 0;
  const covered = lines.filter((l) => (inv.kind === 'recurring' ? l.line_type === 'subscription' : inv.kind === 'one_time' ? l.line_type === 'one_time' : true));
  const rows = covered.map((l) => {
    const eff = E.effectiveDiscount(l.discount_pct, od);
    const net = l.qty * l.unit_price * (1 - eff / 100);
    return [l.description, String(l.qty), l.unit_price.toFixed(2), `${eff.toFixed(1)}%`, net.toFixed(2)];
  });
  if (inv.kind === 'credit_note') rows.push(['Credit note adjustment', '1', inv.amount.toFixed(2), '—', inv.amount.toFixed(2)]);
  const cur = inv.currency === 'INR' ? 'INR' : 'USD';
  const headers = ['Description', 'Qty', `Unit (${cur})`, 'Discount', `Net (${cur})`];
  const title = `DealFlow360 — Invoice ${inv.number}`;
  const meta = [
    `Customer: ${inv.customer_name} (${inv.customer_tier} partner)`,
    `Quotation: ${inv.quote_number}   Type: ${inv.kind.replace(/_/g, ' ')}   Status: ${inv.status.toUpperCase()}`,
    `Issued: ${String(inv.created_at || '').slice(0, 10)}   Due: ${String(inv.due_date || '').slice(0, 10) || '-'}${inv.paid_at ? `   Paid: ${String(inv.paid_at).slice(0, 10)}` : ''}`,
    inv.kind === 'recurring' ? 'Covers the current recurring cycle for subscription lines on this order.' : inv.kind === 'credit_note' ? 'Credit note issued per the subscription cancellation policy.' : 'Covers all one-time products and services on this order.',
  ];
  const foot = ['', '', '', 'TOTAL DUE', `${cur} ${Number(inv.amount).toFixed(2)}`];
  return {
    buffer: buildPDF(title, headers, rows, foot, meta),
    filename: `${inv.number}.pdf`,
  };
}

/* generate due recurring invoices for a quotation */
r.post('/quotations/:id/billing/generate', requireInternal, async (req, res) => {
  const created = await E.generateDueInvoices(Number(req.params.id));
  if (created) await E.audit('quotation', Number(req.params.id), req.user, 'recurring_invoices_generated', `${created} due cycle(s) invoiced`);
  res.json({ created });
});

/* mid-cycle subscription quantity change → prorated adjustment */
r.post('/quotations/:id/lines/:lineId/subscription', requireInternal, async (req, res) => {
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [Number(req.params.id)]);
  const line = await ONE(`SELECT l.* FROM quotation_lines l WHERE l.id=? AND l.quotation_id=?`, [Number(req.params.lineId), q ? q.id : 0]);
  if (!q || !line) return res.status(404).json({ error: 'Line not found' });
  if (line.line_type !== 'subscription') return res.status(400).json({ error: 'Not a subscription line' });
  const action = req.body?.action; // modify | cancel
  if (action === 'modify') {
    const newQty = Number(req.body?.qty);
    if (!newQty || newQty <= 0) return res.status(400).json({ error: 'qty required' });
    const pr = await E.prorateLineChange(line, newQty);
    await RUN('UPDATE quotation_lines SET qty=? WHERE id=?', [newQty, line.id]);
    await E.recomputeTotals(q.id);
    // adjust future schedule entries
    const price = line.unit_price * (1 - E.effectiveDiscount(line.discount_pct, q.order_discount_pct) / 100);
    await RUN(`UPDATE billing_schedule SET amount=? WHERE line_id=? AND status='scheduled'`, [E.r2(newQty * price), line.id]);
    if (pr && pr.delta !== 0) {
      const kind = pr.delta > 0 ? 'recurring' : 'credit_note';
      const inv = await RUN(`INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,${TODAY})`,
        [await E.nextInvoiceNumber(), q.id, q.customer_id, kind, Math.abs(pr.delta), 'open']);
      await E.audit('quotation', q.id, req.user, 'subscription_modified',
        `${line.description}: qty ${line.qty}→${newQty}, daily proration (${pr.days_remaining}/${pr.days_in_cycle} days) → ${kind === 'credit_note' ? 'credit note' : 'charge'} ${Math.abs(pr.delta)} (${inv.lastInsertRowid})`);
    } else {
      await E.audit('quotation', q.id, req.user, 'subscription_modified', `${line.description}: qty ${line.qty}→${newQty} (no prorated delta)`);
    }
  } else if (action === 'cancel') {
    const active = await ONE(`SELECT COUNT(*) c FROM billing_schedule WHERE line_id=? AND status='scheduled'`, [line.id]);
    if (!active.c) return res.status(400).json({ error: 'No active cycles remain on this subscription' });
    const cr = await E.cancelSubscriptionCredit(line);
    await RUN(`UPDATE billing_schedule SET status='cancelled' WHERE line_id=? AND status='scheduled'`, [line.id]);
    if (cr.refund > 0) {
      await RUN(`INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date) VALUES(?,?,?,?,?,?,${TODAY})`,
        [await E.nextInvoiceNumber(), q.id, q.customer_id, 'credit_note', cr.refund, 'open']);
    }
    await E.audit('quotation', q.id, req.user, 'subscription_cancelled',
      `${line.description} cancelled (policy: ${cr.policy}) → credit note ${cr.refund}`);
  } else return res.status(400).json({ error: 'action must be modify|cancel' });
  const out = { quotation: await ONE('SELECT * FROM quotations WHERE id=?', [q.id]) };
  out.schedule = await Q(`SELECT bs.*, l.description FROM billing_schedule bs LEFT JOIN quotation_lines l ON l.id=bs.line_id WHERE bs.quotation_id=? ORDER BY bs.scheduled_date`, [q.id]);
  out.invoices = await Q('SELECT * FROM invoices WHERE quotation_id=? ORDER BY id', [q.id]);
  res.json(out);
});

module.exports = r;
