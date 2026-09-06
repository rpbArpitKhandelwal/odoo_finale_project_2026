/* DealFlow360 — deal health dashboard, KPIs, reports + PDF/XLS/CSV export (PostgreSQL, async) */
'use strict';
const express = require('express');
const { Q, ONE } = require('../db');
const { requireInternal } = require('../util');
const { refreshAlerts, audit } = require('../engines');
const { buildPDF, buildXLS, buildCSV } = require('../exporter');

const r = express.Router();

/* ---- KPI + deal health dashboard ---- */
r.get('/dashboard', requireInternal, async (_req, res) => {
  await refreshAlerts();
  /* All money KPIs are normalised to the reporting currency (USD) via each quotation's exchange_rate, so INR and USD deals never add up naively. */
  const kpi = { reporting_currency: 'USD' };
  kpi.pipeline_value = (await ONE(`SELECT COALESCE(SUM(total/exchange_rate),0) v FROM quotations WHERE status IN ('draft','pending_manager','pending_finance','approved','sent','negotiating','returned')`)).v;
  kpi.pending_approvals = (await ONE(`SELECT COUNT(*) c FROM quotations WHERE status IN ('pending_manager','pending_finance')`)).c;
  kpi.confirmed_value = (await ONE(`SELECT COALESCE(SUM(total/exchange_rate),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`)).v;
  kpi.open_invoices = await ONE(`SELECT COUNT(*) c, COALESCE(SUM(i.amount/q.exchange_rate),0) v FROM invoices i JOIN quotations q ON q.id=i.quotation_id WHERE i.status='open' AND i.kind!='credit_note'`);
  kpi.paid_value = (await ONE(`SELECT COALESCE(SUM(i.amount/q.exchange_rate),0) v FROM invoices i JOIN quotations q ON q.id=i.quotation_id WHERE i.status='paid' AND i.kind!='credit_note'`)).v;
  kpi.avg_discount = (await ONE(`SELECT COALESCE(AVG(CASE WHEN subtotal>0 THEN discount_total/subtotal*100 END),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`)).v;
  kpi.avg_margin = (await ONE(`SELECT COALESCE(AVG(margin_pct),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`)).v;
  kpi.quotes_by_status = await Q(`SELECT status, COUNT(*) c, COALESCE(SUM(total/exchange_rate),0) v FROM quotations GROUP BY status`);
  kpi.monthly = await Q(`SELECT substr(confirmed_at,1,7) m, COUNT(*) c, COALESCE(SUM(total/exchange_rate),0) v, COALESCE(AVG(margin_pct),0) margin
    FROM quotations WHERE confirmed_at IS NOT NULL GROUP BY substr(confirmed_at,1,7) ORDER BY m`);
  kpi.top_products = await Q(`SELECT p.name description, SUM(l.qty) qty, SUM(l.qty*l.unit_price*(1-l.discount_pct/100)/q.exchange_rate) revenue
    FROM quotation_lines l JOIN quotations q ON q.id=l.quotation_id JOIN products p ON p.id=l.product_id WHERE q.status IN ('confirmed','fulfilling','fulfilled')
    GROUP BY p.name ORDER BY revenue DESC LIMIT 6`);
  kpi.recurring_mrr = (await ONE(`SELECT COALESCE(SUM((CASE l.billing_period WHEN 'monthly' THEN l.qty*l.unit_price*(1-l.discount_pct/100)
    WHEN 'quarterly' THEN l.qty*l.unit_price*(1-l.discount_pct/100)/3 ELSE l.qty*l.unit_price*(1-l.discount_pct/100)/12 END)/q.exchange_rate),0) v
    FROM quotation_lines l JOIN quotations q ON q.id=l.quotation_id WHERE l.line_type='subscription' AND q.status IN ('confirmed','fulfilling','fulfilled')
    AND EXISTS (SELECT 1 FROM billing_schedule bs WHERE bs.line_id=l.id AND bs.status='scheduled')`)).v;
  kpi.top_reps = await Q(`SELECT u.name, u.sales_team, COUNT(*) deals, COALESCE(SUM(q.total/q.exchange_rate),0) revenue, COALESCE(AVG(q.margin_pct),0) margin
    FROM quotations q JOIN users u ON u.id=q.rep_id WHERE q.status IN ('confirmed','fulfilling','fulfilled') GROUP BY u.id, u.name, u.sales_team ORDER BY revenue DESC LIMIT 6`);
  kpi.alerts = await Q(`SELECT a.*, q.number, q.total, q.customer_id FROM alerts a JOIN quotations q ON q.id=a.quotation_id
    WHERE a.status='open' ORDER BY CASE a.severity WHEN 'high' THEN 0 ELSE 1 END, a.updated_at DESC`);
  kpi.alert_counts = await Q(`SELECT kind, COUNT(*) c FROM alerts WHERE status='open' GROUP BY kind`);
  res.json({ kpi });
});

r.post('/alerts/:id/:action', requireInternal, async (req, res) => {
  const { id, action } = req.params;
  if (!['nudge', 'escalate', 'dismiss'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const a = await ONE('SELECT * FROM alerts WHERE id=?', [Number(id)]);
  if (!a) return res.status(404).json({ error: 'Alert not found' });
  const q = await ONE('SELECT * FROM quotations WHERE id=?', [a.quotation_id]);
  const rep = q ? await ONE('SELECT * FROM users WHERE id=?', [q.rep_id]) : null;
  if (action === 'nudge') {
    await Q(`UPDATE alerts SET status='nudged', updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id=?`, [a.id]);
    await audit('alert', a.id, req.user, 'nudged', `Nudge sent to ${rep ? rep.name : 'rep'} for ${q ? q.number : ''}`);
  } else if (action === 'escalate') {
    await Q(`UPDATE alerts SET status='escalated', updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id=?`, [a.id]);
    await audit('alert', a.id, req.user, 'escalated', `${q ? q.number : ''} escalated to sales manager`);
  } else {
    await Q(`UPDATE alerts SET status='dismissed', updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id=?`, [a.id]);
    await audit('alert', a.id, req.user, 'dismissed', '');
  }
  res.json({ ok: true });
});

/* ---- reporting with filters: period / rep / approval status / product / category ---- */
async function reportRows(q) {
  const where = [`q.status IN ('confirmed','fulfilling','fulfilled','approved')`];
  const params = [];
  if (q.from) { where.push(`(COALESCE(q.confirmed_at, q.submitted_at, q.created_at))::date >= ?::date`); params.push(q.from); }
  if (q.to) { where.push(`(COALESCE(q.confirmed_at, q.submitted_at, q.created_at))::date <= ?::date`); params.push(q.to); }
  if (q.rep) { where.push('q.rep_id=?'); params.push(q.rep); }
  if (q.approval) {
    if (q.approval === 'none') where.push(`q.approval_level='none'`);
    else where.push(`q.status IN (${['pending_manager', 'pending_finance'].includes(q.approval) ? `'${q.approval}'` : `'approved','confirmed','fulfilling','fulfilled'`}) AND q.approval_level!='none'`);
  }
  if (q.category) { where.push(`q.id IN (SELECT l.quotation_id FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE p.category_id=?)`); params.push(q.category); }
  if (q.product) { where.push(`q.id IN (SELECT l.quotation_id FROM quotation_lines l WHERE l.product_id=?)`); params.push(q.product); }
  const rows = await Q(`SELECT q.id, q.number, q.status, q.approval_level, q.currency, q.exchange_rate, q.subtotal, q.discount_total, q.tax_total, q.total, q.cost_total,
    q.total/q.exchange_rate total_usd, q.discount_total/q.exchange_rate discount_usd,
    q.margin_pct, q.confirmed_at, c.name customer_name, u.name rep_name, u.sales_team rep_team,
    (SELECT COUNT(*) FROM quotation_lines l WHERE l.quotation_id=q.id) line_count
    FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id
    WHERE ${where.join(' AND ')} ORDER BY q.confirmed_at DESC NULLS LAST, q.id DESC`, params);
  const totals = { // reporting currency: USD (INR converted at each quotation's rate)
    count: rows.length,
    revenue: rows.reduce((s, x) => s + x.total_usd, 0),
    discount: rows.reduce((s, x) => s + x.discount_usd, 0),
    margin: rows.length ? rows.reduce((s, x) => s + x.margin_pct, 0) / rows.length : 0,
    currency: 'USD',
  };
  return { rows, totals };
}

r.get('/reports/sales', requireInternal, async (req, res) => {
  res.json(await reportRows(req.query));
});

r.get('/reports/export', requireInternal, async (req, res) => {
  const { rows, totals } = await reportRows(req.query);
  const fmt = (req.query.format || 'csv').toLowerCase();
  const title = `DealFlow360 — Sales Report (${req.query.from || 'start'} → ${req.query.to || 'today'})`;
  const headers = ['Quotation', 'Customer', 'Sales Rep', 'Status', 'Approval', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'Total (USD)', 'Margin %', 'Lines', 'Confirmed'];
  const data = rows.map(x => [x.number, x.customer_name, x.rep_name, x.status, x.approval_level, x.currency,
    x.subtotal.toFixed(2), x.discount_total.toFixed(2), x.tax_total.toFixed(2), x.total.toFixed(2), x.total_usd.toFixed(2), x.margin_pct.toFixed(1), x.line_count, (x.confirmed_at || '').slice(0, 10)]);
  const footer = ['TOTAL (USD)', '', '', `${totals.count} orders`, '', '', '', totals.discount.toFixed(2), '', '', totals.revenue.toFixed(2), totals.margin.toFixed(1), '', ''];
  const fileBase = `dealflow-report-${new Date().toISOString().slice(0, 10)}`;
  if (fmt === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
    res.end(buildPDF(title, headers, data, footer));
  } else if (fmt === 'xls') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xls"`);
    res.end(buildXLS(title, headers, data, footer));
  } else {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
    res.end(buildCSV(headers, data, footer));
  }
  await audit('report', 0, req.user, 'exported', `${fmt.toUpperCase()} export, ${rows.length} rows`);
});

module.exports = r;
