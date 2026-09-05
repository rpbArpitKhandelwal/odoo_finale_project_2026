/* DealFlow360 — assembles a professional invoice PDF document for one invoice.
 * Shared by the internal download (/invoices/:id/pdf) and the tenant-checked
 * portal download (/portal/quote/:number/invoice/:invId/pdf). */
'use strict';
const { Q, ONE } = require('./db');
const E = require('./engines');
const { buildInvoicePDF } = require('./exporter');

async function invoiceDocument(invoiceId) {
  const inv = await ONE(`SELECT i.*, q.number quote_number, q.order_discount_pct, q.currency, q.id qid,
    c.name customer_name, c.tier customer_tier, c.address customer_address
    FROM invoices i JOIN quotations q ON q.id=i.quotation_id JOIN customers c ON c.id=i.customer_id WHERE i.id=?`, [invoiceId]);
  if (!inv) return { error: 'not found' };
  const lines = await Q(`SELECT l.*, p.tax_rate FROM quotation_lines l JOIN products p ON p.id=l.product_id
    WHERE l.quotation_id=? ORDER BY l.sort, l.id`, [inv.qid]);
  const od = inv.order_discount_pct || 0;
  const isCredit = inv.kind === 'credit_note';
  const covered = isCredit ? [] : lines.filter((l) => (inv.kind === 'recurring' ? l.line_type === 'subscription' : l.line_type === 'one_time'));

  const items = covered.map((l) => {
    const eff = E.effectiveDiscount(l.discount_pct, od);
    const gross = l.qty * l.unit_price;
    const net = gross * (1 - eff / 100);
    return { desc: l.description, qty: l.qty, unit: l.unit_price, disc: eff > 0 ? `${eff.toFixed(1)}%` : '-', amount: net };
  });
  if (isCredit) items.push({ desc: 'Credit note - subscription cancellation policy adjustment', qty: 1, unit: inv.amount, disc: '-', amount: inv.amount });

  const subtotal = items.reduce((s, it) => s + it.amount, 0);
  const tax = covered.reduce((s, l) => {
    const eff = E.effectiveDiscount(l.discount_pct, od);
    return s + l.qty * l.unit_price * (1 - eff / 100) * ((l.tax_rate || 0) / 100);
  }, 0);

  const settings = await ONE(`SELECT value FROM settings WHERE key='company_name'`);
  const doc = buildInvoicePDF({
    company: { name: settings ? settings.value : 'DealFlow360 Inc.', tagline: 'Self-Governing Sales Operations Platform' },
    docTitle: isCredit ? 'CREDIT NOTE' : 'INVOICE',
    totalLabel: isCredit ? 'CREDIT DUE' : 'NET TOTAL',
    invoice: { number: inv.number, kind: inv.kind, status: inv.status, issued: String(inv.created_at || '').slice(0, 10), due: String(inv.due_date || '').slice(0, 10), paid: inv.paid_at ? String(inv.paid_at).slice(0, 10) : null },
    metaRows: [
      ['Invoice #', inv.number],
      ['Quotation', inv.quote_number],
      ['Issued', String(inv.created_at || '').slice(0, 10)],
      ['Due', String(inv.due_date || '').slice(0, 10) || '-'],
      ...(inv.paid_at ? [['Paid', String(inv.paid_at).slice(0, 10)]] : []),
      ['Type', isCredit ? 'Credit note' : inv.kind === 'recurring' ? 'Recurring cycle' : 'One-time'],
    ],
    billTo: { name: inv.customer_name, tier: inv.customer_tier, address: inv.customer_address },
    currency: inv.currency === 'INR' ? 'INR' : 'USD',
    items,
    totals: { subtotal, discount: Math.max(0, subtotal + tax - inv.amount), tax, total: inv.amount },
    note: isCredit
      ? 'Issued per the subscription cancellation policy. Apply against the original invoice.'
      : inv.kind === 'recurring'
        ? 'Covers the current recurring cycle for subscription lines on this order.'
        : 'Covers all one-time products and services on this order. Payment due by the due date.',
  });
  return { buffer: doc, filename: `${inv.number}.pdf` };
}

module.exports = { invoiceDocument };
