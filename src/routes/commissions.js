/* DealFlow360 — Sales Commissions module: rules, commission lifecycle, settlement, per-salesperson reporting */
'use strict';
const express = require('express');
const { Q, ONE, RUN, NOW_ISO } = require('../db');
const { requireInternal, requireRole } = require('../util');
const { audit } = require('../engines');

const r = express.Router();

/* ================= COMMISSION RULES (Configuration) ================= */

r.get('/commission-rules', requireInternal, async (_req, res) => {
  const rules = await Q(`SELECT cr.*, u.name salesperson_name, c.name category_name, p.name product_name
    FROM commission_rules cr
    LEFT JOIN users u ON u.id=cr.salesperson_id
    LEFT JOIN categories c ON c.id=cr.category_id
    LEFT JOIN products p ON p.id=cr.product_id
    ORDER BY cr.id`);
  const reps = await Q(`SELECT id, name, sales_team FROM users WHERE role='salesrep' AND active=1 ORDER BY name`);
  res.json({ rules, reps });
});

r.post('/commission-rules', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.scope) return res.status(400).json({ error: 'Name and scope required' });
  const tiers = b.margin_tiers ? JSON.stringify(b.margin_tiers) : null;
  const info = await RUN(`INSERT INTO commission_rules(name,scope,salesperson_id,team,category_id,product_id,rate_type,rate,margin_tiers)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    [b.name, b.scope, b.salesperson_id || null, b.team || null, b.category_id || null, b.product_id || null,
      b.rate_type || 'percentage', b.rate ?? 3, tiers]);
  await audit('commission_rule', info.lastInsertRowid, req.user, 'created', `${b.name} (${b.scope}, ${b.rate_type})`);
  res.json({ rule: await ONE('SELECT * FROM commission_rules WHERE id=?', [info.lastInsertRowid]) });
});

r.put('/commission-rules/:id', requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body || {};
  const tiers = b.margin_tiers ? JSON.stringify(b.margin_tiers) : undefined;
  await RUN(`UPDATE commission_rules SET name=COALESCE(?,name), scope=COALESCE(?,scope), salesperson_id=COALESCE(?,salesperson_id),
    team=COALESCE(?,team), category_id=COALESCE(?,category_id), product_id=COALESCE(?,product_id),
    rate_type=COALESCE(?,rate_type), rate=COALESCE(?,rate),
    margin_tiers=COALESCE(?,margin_tiers), active=COALESCE(?,active) WHERE id=?`,
    [b.name, b.scope, b.salesperson_id, b.team, b.category_id, b.product_id, b.rate_type, b.rate, tiers, b.active, req.params.id]);
  await audit('commission_rule', Number(req.params.id), req.user, 'updated', `rule updated`);
  res.json({ ok: true });
});

r.delete('/commission-rules/:id', requireRole('admin', 'manager'), async (req, res) => {
  await RUN('DELETE FROM commission_rules WHERE id=?', [req.params.id]);
  await audit('commission_rule', Number(req.params.id), req.user, 'deleted', '');
  res.json({ ok: true });
});

/* ================= COMMISSIONS LIST / DETAIL ================= */

r.get('/commissions', requireInternal, async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('cm.status=?'); params.push(req.query.status); }
  if (req.query.salesperson_id) { where.push('cm.salesperson_id=?'); params.push(req.query.salesperson_id); }
  if (req.query.period) { where.push('cm.period=?'); params.push(req.query.period); }
  // salesreps only ever see their own commissions
  if (req.user.role === 'salesrep') { where.push('cm.salesperson_id=?'); params.push(req.user.id); }
  const rows = await Q(`SELECT cm.*, u.name salesperson_name, u.sales_team, q.number quote_number, c.name customer_name, i.number invoice_number
    FROM commissions cm
    JOIN users u ON u.id=cm.salesperson_id
    JOIN quotations q ON q.id=cm.quotation_id
    JOIN customers c ON c.id=q.customer_id
    LEFT JOIN invoices i ON i.id=cm.invoice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY cm.id DESC`, params);
  const sums = {
    total: rows.reduce((s, x) => s + x.amount, 0),
    draft: rows.filter(x => x.status === 'draft').reduce((s, x) => s + x.amount, 0),
    confirmed: rows.filter(x => x.status === 'confirmed').reduce((s, x) => s + x.amount, 0),
    approved: rows.filter(x => x.status === 'approved').reduce((s, x) => s + x.amount, 0),
    paid: rows.filter(x => x.status === 'paid').reduce((s, x) => s + x.amount, 0),
  };
  res.json({ commissions: rows, sums });
});

/* Alias for /commissions/rules so it doesn't collide with :id */
r.get('/commissions/rules', requireInternal, async (req, res, next) => {
  try {
    const rules = await Q(`SELECT cr.*, u.name salesperson_name, c.name category_name, p.name product_name
      FROM commission_rules cr
      LEFT JOIN users u ON u.id=cr.salesperson_id
      LEFT JOIN categories c ON c.id=cr.category_id
      LEFT JOIN products p ON p.id=cr.product_id
      ORDER BY cr.id`);
    const reps = await Q(`SELECT id, name, sales_team FROM users WHERE role='salesrep' AND active=1 ORDER BY name`);
    res.json({ rules, reps });
  } catch (e) { next(e); }
});

r.get('/commissions/:id', requireInternal, async (req, res, next) => {
  if (isNaN(Number(req.params.id))) return next();
  const row = await ONE(`SELECT cm.*, u.name salesperson_name, u.sales_team, q.number quote_number, q.total quote_total, q.margin_pct quote_margin,
    c.name customer_name, i.number invoice_number, i.amount invoice_amount
    FROM commissions cm
    JOIN users u ON u.id=cm.salesperson_id
    JOIN quotations q ON q.id=cm.quotation_id
    JOIN customers c ON c.id=q.customer_id
    LEFT JOIN invoices i ON i.id=cm.invoice_id
    WHERE cm.id=?`, [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Commission not found' });
  if (req.user.role === 'salesrep' && row.salesperson_id !== req.user.id) return res.status(403).json({ error: 'Salespeople can only view their own commissions' });
  const auditRows = await Q(`SELECT * FROM audit_log WHERE entity='commission' AND entity_id=? ORDER BY id DESC`, [row.id]);
  res.json({ commission: row, audit: auditRows });
});

/* lifecycle: draft → confirmed (rep verifies) → approved (manager) → paid (finance settles) */
r.post('/commissions/:id/confirm', requireInternal, async (req, res) => {
  const cm = await ONE('SELECT * FROM commissions WHERE id=?', [Number(req.params.id)]);
  if (!cm) return res.status(404).json({ error: 'Commission not found' });
  if (cm.status !== 'draft') return res.status(400).json({ error: `Commission is ${cm.status}` });
  const allowed = ['manager', 'admin', 'finance'].includes(req.user.role) || cm.salesperson_id === req.user.id;
  if (!allowed) return res.status(403).json({ error: 'Only the owning salesperson or a manager can confirm' });
  await RUN(`UPDATE commissions SET status='confirmed', confirmed_at=${NOW_ISO} WHERE id=?`, [cm.id]);
  await audit('commission', cm.id, req.user, 'confirmed', `${cm.number} confirmed`);
  res.json({ commission: await ONE('SELECT * FROM commissions WHERE id=?', [cm.id]) });
});

r.post('/commissions/:id/approve', requireRole('manager', 'admin'), async (req, res) => {
  const cm = await ONE('SELECT * FROM commissions WHERE id=?', [Number(req.params.id)]);
  if (!cm) return res.status(404).json({ error: 'Commission not found' });
  if (cm.status !== 'confirmed') return res.status(400).json({ error: `Commission must be confirmed first (currently ${cm.status})` });
  await RUN(`UPDATE commissions SET status='approved', approved_at=${NOW_ISO} WHERE id=?`, [cm.id]);
  await audit('commission', cm.id, req.user, 'approved', `${cm.number} approved for settlement`);
  res.json({ commission: await ONE('SELECT * FROM commissions WHERE id=?', [cm.id]) });
});

r.post('/commissions/:id/cancel', requireRole('manager', 'admin'), async (req, res) => {
  const cm = await ONE('SELECT * FROM commissions WHERE id=?', [Number(req.params.id)]);
  if (!cm) return res.status(404).json({ error: 'Commission not found' });
  if (cm.status === 'paid') return res.status(400).json({ error: 'Already settled' });
  await RUN(`UPDATE commissions SET status='draft', confirmed_at=NULL, approved_at=NULL WHERE id=?`, [cm.id]);
  await audit('commission', cm.id, req.user, 'reset', `${cm.number} reset to draft`);
  res.json({ commission: await ONE('SELECT * FROM commissions WHERE id=?', [cm.id]) });
});

/* finance settles every approved commission (optionally one period / one rep) in a single payout run */
r.post('/commissions/settle', requireRole('finance', 'admin'), async (req, res) => {
  const where = [`status='approved'`];
  const params = [];
  if (req.body?.period) { where.push('period=?'); params.push(req.body.period); }
  if (req.body?.salesperson_id) { where.push('salesperson_id=?'); params.push(req.body.salesperson_id); }
  const rows = await Q(`SELECT * FROM commissions WHERE ${where.join(' AND ')}`, params);
  if (!rows.length) return res.status(400).json({ error: 'No approved commissions to settle' });
  let total = 0;
  for (const cm of rows) {
    await RUN(`UPDATE commissions SET status='paid', paid_at=${NOW_ISO} WHERE id=?`, [cm.id]);
    total += cm.amount;
  }
  await audit('commission', 0, req.user, 'settled', `Settled ${rows.length} commission(s): ${rows.map(x => x.number).join(', ')} → total $${Math.round(total * 100) / 100}`);
  res.json({ settled: rows.length, total: Math.round(total * 100) / 100 });
});

/* ================= REPORTS ================= */

/* Commissions by Salesperson — the aggregate report (per rep: totals by status, order count, avg rate) */
r.get('/commissions/report/by-salesperson', requireInternal, async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.from) { where.push('cm.period >= substr(?,1,7)'); params.push(req.query.from); }
  if (req.query.to) { where.push('cm.period <= substr(?,1,7)'); params.push(req.query.to); }
  const rows = await Q(`SELECT u.id salesperson_id, u.name salesperson_name, u.sales_team,
      COUNT(*) orders,
      COALESCE(SUM(cm.base_amount),0) invoiced,
      COALESCE(SUM(cm.amount),0) total_commission,
      COALESCE(SUM(CASE WHEN cm.status='draft' THEN cm.amount ELSE 0 END),0) draft,
      COALESCE(SUM(CASE WHEN cm.status='confirmed' THEN cm.amount ELSE 0 END),0) confirmed,
      COALESCE(SUM(CASE WHEN cm.status='approved' THEN cm.amount ELSE 0 END),0) approved,
      COALESCE(SUM(CASE WHEN cm.status='paid' THEN cm.amount ELSE 0 END),0) paid,
      COALESCE(AVG(cm.rate),0) avg_rate
    FROM commissions cm JOIN users u ON u.id=cm.salesperson_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY u.id, u.name, u.sales_team
    ORDER BY total_commission DESC`, params);
  const months = await Q(`SELECT period, COALESCE(SUM(amount),0) total FROM commissions GROUP BY period ORDER BY period`);
  res.json({ by_salesperson: rows, by_period: months });
});

/* Sales Commission Detail — every commission row with quote context for drill-down */
r.get('/commissions/report/detail', requireInternal, async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.salesperson_id) { where.push('cm.salesperson_id=?'); params.push(req.query.salesperson_id); }
  if (req.query.status) { where.push('cm.status=?'); params.push(req.query.status); }
  if (req.user.role === 'salesrep') { where.push('cm.salesperson_id=?'); params.push(req.user.id); }
  const rows = await Q(`SELECT cm.*, u.name salesperson_name, u.sales_team, q.number quote_number, c.name customer_name, i.number invoice_number
    FROM commissions cm
    JOIN users u ON u.id=cm.salesperson_id
    JOIN quotations q ON q.id=cm.quotation_id
    JOIN customers c ON c.id=q.customer_id
    LEFT JOIN invoices i ON i.id=cm.invoice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY cm.period DESC, cm.id DESC`, params);
  res.json({ detail: rows });
});

/* commission export (CSV/XLS/PDF) */
r.get('/commissions/export', requireInternal, async (req, res) => {
  const { buildPDF, buildXLS, buildCSV } = require('../exporter');
  const rows = await Q(`SELECT cm.number, u.name salesperson_name, u.sales_team, q.number quote_number, c.name customer_name,
    cm.base_amount, cm.margin_pct, cm.rule_name, cm.rate, cm.rate_type, cm.amount, cm.status, cm.period
    FROM commissions cm JOIN users u ON u.id=cm.salesperson_id JOIN quotations q ON q.id=cm.quotation_id
    JOIN customers c ON c.id=q.customer_id
    ${req.user.role === 'salesrep' ? 'WHERE cm.salesperson_id=?' : ''} ORDER BY cm.period DESC, cm.id DESC`,
    req.user.role === 'salesrep' ? [req.user.id] : []);
  const fmt = (req.query.format || 'csv').toLowerCase();
  const title = `DealFlow360 — Commission Statement (${new Date().toISOString().slice(0, 10)})`;
  const headers = ['Commission', 'Salesperson', 'Team', 'Quotation', 'Customer', 'Invoiced Base', 'Order Margin %', 'Rule', 'Rate', 'Type', 'Amount', 'Status', 'Period'];
  const data = rows.map(x => [x.number, x.salesperson_name, x.sales_team, x.quote_number, x.customer_name,
    x.base_amount.toFixed(2), x.margin_pct.toFixed(1), x.rule_name,
    x.rate_type === 'fixed' ? `$${x.rate}` : `${x.rate}%`, x.rate_type, x.amount.toFixed(2), x.status, x.period]);
  const total = rows.reduce((s, x) => s + x.amount, 0);
  const footer = ['TOTAL', '', '', `${rows.length} commissions`, '', '', '', '', '', '', total.toFixed(2), '', ''];
  const fileBase = `dealflow-commissions-${new Date().toISOString().slice(0, 10)}`;
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
  await audit('report', 0, req.user, 'exported', `Commission ${fmt.toUpperCase()} export, ${rows.length} rows`);
});

module.exports = r;
