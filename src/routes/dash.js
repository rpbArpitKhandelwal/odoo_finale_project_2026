/* DealFlow360 — deal health dashboard, KPIs, reports + PDF/XLS/CSV export */
'use strict';
const express = require('express');
const { db, getSetting } = require('../db');
const { requireInternal } = require('../util');
const { refreshAlerts, audit } = require('../engines');
const { buildPDF, buildXLS, buildCSV } = require('../exporter');

const r = express.Router();

/* ---- KPI + deal health dashboard ---- */
r.get('/dashboard', requireInternal, (req, res) => {
  refreshAlerts();
  const kpi = {};
  kpi.pipeline_value = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM quotations WHERE status IN ('draft','pending_manager','pending_finance','sent','negotiating','returned')`).get().v;
  kpi.pending_approvals = db.prepare(`SELECT COUNT(*) c FROM quotations WHERE status IN ('pending_manager','pending_finance')`).get().c;
  kpi.confirmed_value = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`).get().v;
  kpi.open_invoices = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) v FROM invoices WHERE status='open' AND kind!='credit_note'`).get();
  kpi.paid_value = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE status='paid'`).get().v;
  kpi.avg_discount = db.prepare(`SELECT COALESCE(AVG(CASE WHEN subtotal>0 THEN discount_total/subtotal*100 END),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`).get().v;
  kpi.avg_margin = db.prepare(`SELECT COALESCE(AVG(margin_pct),0) v FROM quotations WHERE status IN ('confirmed','fulfilling','fulfilled')`).get().v;
  kpi.quotes_by_status = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(total),0) v FROM quotations GROUP BY status`).all();
  kpi.monthly = db.prepare(`SELECT substr(confirmed_at,1,7) m, COUNT(*) c, COALESCE(SUM(total),0) v, COALESCE(AVG(margin_pct),0) margin
    FROM quotations WHERE confirmed_at IS NOT NULL GROUP BY substr(confirmed_at,1,7) ORDER BY m`).all();
  kpi.top_products = db.prepare(`SELECT l.description, SUM(l.qty) qty, SUM(l.qty*l.unit_price*(1-l.discount_pct/100)) revenue
    FROM quotation_lines l JOIN quotations q ON q.id=l.quotation_id WHERE q.status IN ('confirmed','fulfilling','fulfilled')
    GROUP BY l.description ORDER BY revenue DESC LIMIT 6`).all();
  kpi.recurring_mrr = db.prepare(`SELECT COALESCE(SUM(CASE l.billing_period WHEN 'monthly' THEN l.qty*l.unit_price*(1-l.discount_pct/100)
    WHEN 'quarterly' THEN l.qty*l.unit_price*(1-l.discount_pct/100)/3 ELSE l.qty*l.unit_price*(1-l.discount_pct/100)/12 END),0) v
    FROM quotation_lines l JOIN quotations q ON q.id=l.quotation_id WHERE l.line_type='subscription' AND q.status IN ('confirmed','fulfilling','fulfilled')`).get().v;
  kpi.alerts = db.prepare(`SELECT a.*, q.number, q.total, q.customer_id FROM alerts a JOIN quotations q ON q.id=a.quotation_id
    WHERE a.status='open' ORDER BY CASE a.severity WHEN 'high' THEN 0 ELSE 1 END, a.updated_at DESC`).all();
  kpi.alert_counts = db.prepare(`SELECT kind, COUNT(*) c FROM alerts WHERE status='open' GROUP BY kind`).all();
  res.json({ kpi });
});

r.post('/alerts/:id/:action', requireInternal, (req, res) => {
  const { id, action } = req.params;
  if (!['nudge', 'escalate', 'dismiss'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const a = db.prepare('SELECT * FROM alerts WHERE id=?').get(Number(id));
  if (!a) return res.status(404).json({ error: 'Alert not found' });
  const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(a.quotation_id);
  const rep = q ? db.prepare('SELECT * FROM users WHERE id=?').get(q.rep_id) : null;
  if (action === 'nudge') {
    db.prepare(`UPDATE alerts SET status='nudged', updated_at=datetime('now') WHERE id=?`).run(a.id);
    audit('alert', a.id, req.user, 'nudged', `Nudge sent to ${rep ? rep.name : 'rep'} for ${q ? q.number : ''}`);
  } else if (action === 'escalate') {
    db.prepare(`UPDATE alerts SET status='escalated', updated_at=datetime('now') WHERE id=?`).run(a.id);
    audit('alert', a.id, req.user, 'escalated', `${q ? q.number : ''} escalated to sales manager`);
  } else {
    db.prepare(`UPDATE alerts SET status='dismissed', updated_at=datetime('now') WHERE id=?`).run(a.id);
    audit('alert', a.id, req.user, 'dismissed', '');
  }
  res.json({ ok: true });
});

/* ---- reporting with filters: period / rep / approval status / product / category ---- */
function reportRows(q) {
  const where = [`q.status IN ('confirmed','fulfilling','fulfilled','approved')`];
  const params = [];
  if (q.from) { where.push(`date(COALESCE(q.confirmed_at, q.submitted_at, q.created_at)) >= ?`); params.push(q.from); }
  if (q.to) { where.push(`date(COALESCE(q.confirmed_at, q.submitted_at, q.created_at)) <= ?`); params.push(q.to); }
  if (q.rep) { where.push('q.rep_id=?'); params.push(q.rep); }
  if (q.approval) {
    if (q.approval === 'none') where.push(`q.approval_level='none'`);
    else where.push(`q.status IN (${['pending_manager','pending_finance'].includes(q.approval) ? `'${q.approval}'` : `'approved','confirmed','fulfilling','fulfilled'`} ) AND q.approval_level!='none'`);
  }
  if (q.category) { where.push(`q.id IN (SELECT l.quotation_id FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE p.category_id=?)`); params.push(q.category); }
  if (q.product) { where.push(`q.id IN (SELECT l.quotation_id FROM quotation_lines l WHERE l.product_id=?)`); params.push(q.product); }
  const rows = db.prepare(`SELECT q.number, q.status, q.approval_level, q.currency, q.subtotal, q.discount_total, q.tax_total, q.total, q.cost_total,
    q.margin_pct, q.confirmed_at, c.name customer_name, u.name rep_name,
    (SELECT COUNT(*) FROM quotation_lines l WHERE l.quotation_id=q.id) line_count
    FROM quotations q JOIN customers c ON c.id=q.customer_id JOIN users u ON u.id=q.rep_id
    WHERE ${where.join(' AND ')} ORDER BY q.confirmed_at DESC NULLS LAST`).all(...params);
  const totals = {
    count: rows.length,
    revenue: rows.reduce((s, x) => s + x.total, 0),
    discount: rows.reduce((s, x) => s + x.discount_total, 0),
    margin: rows.length ? rows.reduce((s, x) => s + x.margin_pct, 0) / rows.length : 0,
  };
  return { rows, totals };
}

r.get('/reports/sales', requireInternal, (req, res) => {
  res.json(reportRows(req.query));
});

r.get('/reports/export', requireInternal, (req, res) => {
  const { rows, totals } = reportRows(req.query);
  const fmt = (req.query.format || 'csv').toLowerCase();
  const title = `DealFlow360 — Sales Report (${req.query.from || 'start'} → ${req.query.to || 'today'})`;
  const headers = ['Quotation', 'Customer', 'Sales Rep', 'Status', 'Approval', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'Margin %', 'Lines', 'Confirmed'];
  const data = rows.map(x => [x.number, x.customer_name, x.rep_name, x.status, x.approval_level, x.currency,
    x.subtotal.toFixed(2), x.discount_total.toFixed(2), x.tax_total.toFixed(2), x.total.toFixed(2), x.margin_pct.toFixed(1), x.line_count, x.confirmed_at || '']);
  const footer = ['TOTAL', '', '', `${totals.count} orders`, '', '', '', totals.discount.toFixed(2), '', totals.revenue.toFixed(2), totals.margin.toFixed(1), '', ''];
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
  audit('report', 0, req.user, 'exported', `${fmt.toUpperCase()} export, ${rows.length} rows`);
});

module.exports = r;
