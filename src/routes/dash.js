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


module.exports = r;
