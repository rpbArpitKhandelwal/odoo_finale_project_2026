/* DealFlow360 — CUSTOMER PORTAL (restricted, separate surface: portal session or per-quote magic link) (PostgreSQL, async)
 *
 * Every route here runs behind requirePortal: the caller is either a customer with a portal session cookie
 * (sees ONLY their own company's quotations) or the holder of a per-quotation magic link (sees ONLY that quotation).
 * Internal staff sessions are rejected on this surface. Nothing here is reachable anonymously. */
'use strict';
const express = require('express');
const { Q, ONE, RUN, NOW_ISO } = require('../db');
const { requirePortal } = require('../util');
const E = require('../engines');

const r = express.Router();

/* customer-facing status vocabulary (the brief: Sent / Under Negotiation / Confirmed) */
function portalStatus(q) {
  if (['pending_manager', 'pending_finance'].includes(q.status)) return q.customer_confirmed_at ? 'Confirmed — awaiting internal approval' : 'Under internal review';
  if (['confirmed', 'fulfilling', 'fulfilled'].includes(q.status)) return 'Confirmed';
  if (q.status === 'approved') return q.customer_confirmed_at ? 'Confirmed' : 'Ready for your review';
  if (q.status === 'negotiating') return 'Under Negotiation';
  if (q.status === 'sent') return 'Sent';
  if (q.status === 'rejected') return 'Declined internally';
  if (q.status === 'cancelled') return 'Cancelled';
  return 'In preparation';
}

/* resolve which quotation the portal caller may see */
async function resolveQuote(req, number) {
  if (req.via === 'magic') return req.quote.number === number ? req.quote : null;
  const q = await ONE('SELECT * FROM quotations WHERE number=?', [number]);
  if (!q) return null;
  return q.customer_id === req.user.customer_id ? q : null; // customers only ever see their own quotes
}
async function portalView(q) {
  const lines = await Q(`SELECT l.id, l.product_id, l.description, l.qty, l.unit_price, l.discount_pct, l.line_type, l.billing_period, p.tax_rate, p.sku
    FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE l.quotation_id=? ORDER BY l.sort, l.id`, [q.id]);
  for (const l of lines) {
    l.gross = E.r2(l.qty * l.unit_price);
    l.effective_discount = Math.round(E.effectiveDiscount(l.discount_pct, q.order_discount_pct) * 100) / 100;
    l.net = E.r2(l.gross * (1 - l.effective_discount / 100));
  }
  const rep = await ONE('SELECT name, email FROM users WHERE id=?', [q.rep_id]);
  return {
    number: q.number, status: q.status, portal_status: portalStatus(q), currency: q.currency,
    subtotal: q.subtotal, discount_total: q.discount_total, tax_total: q.tax_total, total: q.total,
    valid_until: q.valid_until, expected_delivery: q.expected_delivery, created_at: q.created_at, sent_at: q.sent_at,
    customer_confirmed_at: q.customer_confirmed_at, order_discount_pct: q.order_discount_pct,
    can_negotiate: ['sent', 'negotiating'].includes(q.status),
    can_confirm: ['sent', 'negotiating', 'approved'].includes(q.status) && !q.customer_confirmed_at,
    lines,
    thread: await Q(`SELECT n.id, n.line_id, n.user_id, n.user_name, n.kind, n.message, n.proposed_discount, n.status, n.created_at, n.resolved_at,
        l.description line_label, CASE WHEN n.user_id IS NULL THEN 'customer' ELSE 'staff' END author
      FROM negotiations n LEFT JOIN quotation_lines l ON l.id=n.line_id WHERE n.quotation_id=? ORDER BY n.id ASC LIMIT 100`, [q.id]),
    invoices: await Q(`SELECT id, number, kind, amount, status, due_date, created_at FROM invoices WHERE quotation_id=? AND status!='void' ORDER BY id`, [q.id]),
    schedule: await Q(`SELECT scheduled_date, description, amount, status FROM billing_schedule WHERE quotation_id=? AND status!='cancelled' ORDER BY scheduled_date LIMIT 12`, [q.id]),
    customer: await ONE('SELECT name, tier FROM customers WHERE id=?', [q.customer_id]),
    salesperson: rep ? { name: rep.name, email: rep.email } : null,
  };
}

/* list: portal-login customers see every quotation of their own company */
r.get('/portal/quotes', requirePortal, async (req, res) => {
  if (req.via === 'magic') return res.status(403).json({ error: 'Magic link is for a single quotation' });
  const rows = await Q(`SELECT q.id, q.number, q.status, q.total, q.currency, q.created_at, q.valid_until, q.customer_confirmed_at,
      (SELECT COUNT(*) FROM negotiations n WHERE n.quotation_id=q.id AND n.status='open') open_requests,
      (SELECT COUNT(*) FROM invoices i WHERE i.quotation_id=q.id AND i.status='open' AND i.kind!='credit_note') open_invoices
    FROM quotations q WHERE q.customer_id=? AND q.status NOT IN ('draft','returned','rejected','cancelled') ORDER BY q.id DESC`, [req.user.customer_id]);
  for (const q of rows) q.portal_status = portalStatus(q);
  res.json({ quotes: rows, customer: { name: req.user.customer_name, tier: req.user.customer_tier } });
});

r.get('/portal/quote/:number', requirePortal, async (req, res) => {
  const q = await resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  res.json({ quote: await portalView(q), via: req.via });
});

/* download an invoice PDF — portal callers may only fetch invoices of the quote they hold */
r.get('/portal/quote/:number/invoice/:invId/pdf', requirePortal, async (req, res) => {
  const q = await resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const inv = await ONE('SELECT id, status FROM invoices WHERE id=? AND quotation_id=?', [Number(req.params.invId), q.id]);
  if (!inv || inv.status === 'void') return res.status(404).json({ error: 'Invoice not found' });
  const { invoiceDocument } = require('../invoiceDoc');
  const out = await invoiceDocument(Number(req.params.invId));
  if (out.error) return res.status(404).json({ error: 'Invoice not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.end(out.buffer);
});

function portalAuthor(req) { return req.user ? req.user.name : 'Customer (secure link)'; }

/* line-level question or change request */
r.post('/portal/quote/:number/comment', requirePortal, async (req, res) => {
  const q = await resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['sent', 'negotiating'].includes(q.status)) return res.status(400).json({ error: `Quotation is ${portalStatus(q).toLowerCase()} — the discussion is closed` });
  const { line_id, message } = req.body || {};
  const kind = req.body?.kind === 'change_request' ? 'change_request' : 'comment';
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
  let lineId = null;
  if (line_id) {
    const l = await ONE('SELECT id FROM quotation_lines WHERE id=? AND quotation_id=?', [Number(line_id), q.id]);
    if (!l) return res.status(400).json({ error: 'That line does not belong to this quotation' });
    lineId = l.id;
  }
  const who = portalAuthor(req);
  await RUN(`INSERT INTO negotiations(quotation_id,line_id,user_id,user_name,kind,message,status) VALUES(?,?,NULL,?,?,?,'open')`,
    [q.id, lineId, who, kind, String(message).trim()]);
  await RUN(`UPDATE quotations SET status=CASE WHEN status='sent' THEN 'negotiating' ELSE status END, last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  await E.audit('quotation', q.id, null, kind === 'change_request' ? 'portal_change_request' : 'portal_comment', `${who}${lineId ? ` on line ${lineId}` : ''}: ${String(message).trim()}`);
  res.json({ quote: await portalView(await ONE('SELECT * FROM quotations WHERE id=?', [q.id])) });
});

/* counter discount proposal */
r.post('/portal/quote/:number/counter', requirePortal, async (req, res) => {
  const q = await resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['sent', 'negotiating'].includes(q.status)) return res.status(400).json({ error: `Quotation is ${portalStatus(q).toLowerCase()} — negotiation is closed` });
  const proposed = Number(req.body?.discount_pct);
  const message = String(req.body?.message || '').trim();
  if (!(proposed >= 0) || proposed > 90) return res.status(400).json({ error: 'Proposed discount must be 0–90%' });
  const who = portalAuthor(req);
  await RUN(`INSERT INTO negotiations(quotation_id,user_id,user_name,kind,message,proposed_discount,status) VALUES(?,NULL,?,'counter',?,?,'open')`,
    [q.id, who, message || `Counter proposal: ${proposed}% discount on all lines`, proposed]);
  await RUN(`UPDATE quotations SET status='negotiating', last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
  await E.audit('quotation', q.id, null, 'portal_counter', `${who} countered at ${proposed}%${message ? ` — "${message}"` : ''}`);
  res.json({ quote: await portalView(await ONE('SELECT * FROM quotations WHERE id=?', [q.id])) });
});

/* one-click confirm — re-enters approval automatically if negotiated terms now exceed ceilings */
r.post('/portal/quote/:number/confirm', requirePortal, async (req, res) => {
  const q = await resolveQuote(req, req.params.number);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (!['sent', 'negotiating', 'approved'].includes(q.status) || q.customer_confirmed_at) return res.status(400).json({ error: `Quotation is ${portalStatus(q).toLowerCase()} and cannot be confirmed again` });
  const who = portalAuthor(req);
  // if there is an OPEN counter that the rep has not accepted, confirming accepts it implicitly (negotiated terms)
  const openCounter = await ONE(`SELECT * FROM negotiations WHERE quotation_id=? AND kind='counter' AND status='open' ORDER BY id DESC LIMIT 1`, [q.id]);
  if (openCounter && openCounter.proposed_discount != null) {
    await RUN('UPDATE quotation_lines SET discount_pct=? WHERE quotation_id=?', [openCounter.proposed_discount, q.id]);
    await RUN(`UPDATE quotations SET order_discount_pct=0 WHERE id=?`, [q.id]);
    await RUN(`UPDATE negotiations SET status='accepted', resolved_at=${NOW_ISO} WHERE id=?`, [openCounter.id]);
  }
  await E.recomputeTotals(q.id);
  const fresh = await ONE('SELECT * FROM quotations WHERE id=?', [q.id]);
  const { level, risk } = await E.requiredApprovalLevel(fresh);
  await RUN(`UPDATE quotations SET customer_confirmed_at=${NOW_ISO} WHERE id=?`, [q.id]);
  if (level !== 'none') {
    await RUN(`UPDATE quotations SET status='pending_manager', approval_level=?, last_activity_at=${NOW_ISO} WHERE id=?`, [level, q.id]);
    await E.routeForApproval(q.id, level);
    await E.audit('quotation', q.id, null, 're_entered_approval',
      `${who} confirmed negotiated terms${openCounter ? ` (counter ${openCounter.proposed_discount}% applied)` : ''} — blended risk ${risk.risk_score} → automatically re-routed to ${level === 'finance' ? 'Manager → Finance' : 'Sales Manager'}`);
  } else {
    await RUN(`UPDATE quotations SET status='approved', last_activity_at=${NOW_ISO} WHERE id=?`, [q.id]);
    await E.audit('quotation', q.id, null, 'customer_confirmed', `${who} confirmed the quotation on the portal (terms within limits) — ready for fulfillment`);
  }
  const openComments = await ONE(`SELECT COUNT(*) c FROM negotiations WHERE quotation_id=? AND status='open'`, [q.id]);
  if (openComments.c) await RUN(`UPDATE negotiations SET status='accepted', resolved_at=${NOW_ISO} WHERE quotation_id=? AND status='open'`, [q.id]);
  res.json({ quote: await portalView(await ONE('SELECT * FROM quotations WHERE id=?', [q.id])), re_approval: level });
});

module.exports = r;
