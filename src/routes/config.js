/* DealFlow360 — backend configuration routes (catalog, pricing, governance, warehouses, plans, upsell, settings) */
'use strict';
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { requireRole, requireInternal } = require('../util');
const { audit } = require('../engines');

const r = express.Router();

/* ---- catalog: categories ---- */
r.get('/categories', requireInternal, (_q, res) => res.json({ categories: db.prepare('SELECT * FROM categories ORDER BY name').all() }));
r.post('/categories', requireRole('admin'), (req, res) => {
  const { name, discount_ceiling } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)').run(name, discount_ceiling ?? 20);
  audit('category', Number(info.lastInsertRowid), req.user, 'created', `${name} (ceiling ${discount_ceiling}%)`);
  res.json({ category: db.prepare('SELECT * FROM categories WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.put('/categories/:id', requireRole('admin'), (req, res) => {
  const { name, discount_ceiling } = req.body || {};
  db.prepare('UPDATE categories SET name=COALESCE(?,name), discount_ceiling=COALESCE(?,discount_ceiling) WHERE id=?').run(name, discount_ceiling, req.params.id);
  audit('category', Number(req.params.id), req.user, 'updated', `ceiling → ${discount_ceiling}`);
  res.json({ ok: true });
});

/* ---- catalog: products (+variants) ---- */
r.get('/products', requireInternal, (_q, res) => {
  const products = db.prepare(`SELECT p.*, c.name category_name, c.discount_ceiling FROM products p JOIN categories c ON c.id=p.category_id ORDER BY c.name, p.name`).all();
  const variants = db.prepare('SELECT * FROM product_variants ORDER BY product_id, id').all();
  const plans = db.prepare(`SELECT pp.*, sp.name plan_name, sp.billing_period FROM product_plans pp JOIN subscription_plans sp ON sp.id=pp.plan_id`).all();
  res.json({ products, variants, plans });
});
r.post('/products', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.sku || !b.category_id) return res.status(400).json({ error: 'Name, SKU and category are required' });
  try {
    const info = db.prepare(`INSERT INTO products(name,sku,category_id,product_type,base_price,cost_price,unit,tax_rate,description,promoted,stocked)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.name, b.sku, b.category_id, b.product_type || 'one_time', b.base_price || 0, b.cost_price || 0, b.unit || 'units', b.tax_rate || 0, b.description || '', b.promoted ? 1 : 0, b.stocked === 0 ? 0 : 1);
    audit('product', Number(info.lastInsertRowid), req.user, 'created', `${b.sku} ${b.name}`);
    res.json({ product: db.prepare('SELECT * FROM products WHERE id=?').get(Number(info.lastInsertRowid)) });
  } catch (e) { res.status(400).json({ error: 'SKU already exists' }); }
});
r.put('/products/:id', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE products SET name=COALESCE(?,name), base_price=COALESCE(?,base_price), cost_price=COALESCE(?,cost_price),
    tax_rate=COALESCE(?,tax_rate), description=COALESCE(?,description), promoted=COALESCE(?,promoted), active=COALESCE(?,active),
    category_id=COALESCE(?,category_id), stocked=COALESCE(?,stocked) WHERE id=?`)
    .run(b.name, b.base_price, b.cost_price, b.tax_rate, b.description, b.promoted, b.active, b.category_id, b.stocked, req.params.id);
  audit('product', Number(req.params.id), req.user, 'updated', `product updated`);
  res.json({ ok: true });
});
r.post('/products/:id/variants', requireRole('admin'), (req, res) => {
  const { attribute, value, extra_price } = req.body || {};
  if (!attribute || !value) return res.status(400).json({ error: 'Attribute and value required' });
  const info = db.prepare('INSERT INTO product_variants(product_id,attribute,value,extra_price) VALUES(?,?,?,?)').run(req.params.id, attribute, value, extra_price || 0);
  audit('product', Number(req.params.id), req.user, 'variant_added', `${attribute}: ${value} (+${extra_price || 0})`);
  res.json({ variant: db.prepare('SELECT * FROM product_variants WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.delete('/variants/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM product_variants WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---- price lists ---- */
r.get('/price-lists', requireInternal, (_q, res) => res.json({ price_lists: db.prepare('SELECT * FROM price_lists ORDER BY name').all() }));
r.post('/price-lists', requireRole('admin'), (req, res) => {
  const { name, customer_tier, currency, rule_type, value } = req.body || {};
  if (!name || !customer_tier) return res.status(400).json({ error: 'Name and tier required' });
  const info = db.prepare('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)')
    .run(name, customer_tier, currency || 'USD', rule_type || 'discount', value || 0);
  audit('price_list', Number(info.lastInsertRowid), req.user, 'created', `${name}`);
  res.json({ price_list: db.prepare('SELECT * FROM price_lists WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.put('/price-lists/:id', requireRole('admin'), (req, res) => {
  const { name, customer_tier, currency, rule_type, value, active } = req.body || {};
  db.prepare('UPDATE price_lists SET name=COALESCE(?,name),customer_tier=COALESCE(?,customer_tier),currency=COALESCE(?,currency),rule_type=COALESCE(?,rule_type),value=COALESCE(?,value),active=COALESCE(?,active) WHERE id=?')
    .run(name, customer_tier, currency, rule_type, value, active, req.params.id);
  res.json({ ok: true });
});
r.delete('/price-lists/:id', requireRole('admin'), (req, res) => { db.prepare('DELETE FROM price_lists WHERE id=?').run(req.params.id); res.json({ ok: true }); });

/* ---- discount governance: tiers + approval chain ---- */
r.get('/governance', requireInternal, (_q, res) => {
  res.json({
    discount_tiers: db.prepare('SELECT * FROM discount_tiers ORDER BY max_discount_pct').all(),
    approval_rules: db.prepare('SELECT * FROM approval_rules ORDER BY sequence').all(),
  });
});
r.put('/discount-tiers/:tier', requireRole('admin'), (req, res) => {
  const { max_discount_pct } = req.body || {};
  db.prepare('UPDATE discount_tiers SET max_discount_pct=? WHERE customer_tier=?').run(max_discount_pct, req.params.tier);
  audit('discount_tier', 0, req.user, 'updated', `${req.params.tier} ceiling → ${max_discount_pct}%`);
  res.json({ ok: true });
});
r.post('/approval-rules', requireRole('admin'), (req, res) => {
  const { name, level, risk_min, risk_max, any_line_over, sequence } = req.body || {};
  const info = db.prepare('INSERT INTO approval_rules(name,level,risk_min,risk_max,any_line_over,sequence) VALUES(?,?,?,?,?,?)')
    .run(name, level, risk_min ?? 0, risk_max ?? 999, any_line_over ?? null, sequence ?? 1);
  audit('approval_rule', Number(info.lastInsertRowid), req.user, 'created', name);
  res.json({ rule: db.prepare('SELECT * FROM approval_rules WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.put('/approval-rules/:id', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE approval_rules SET name=COALESCE(?,name),risk_min=COALESCE(?,risk_min),risk_max=COALESCE(?,risk_max),any_line_over=?,sequence=COALESCE(?,sequence),active=COALESCE(?,active) WHERE id=?')
    .run(b.name, b.risk_min, b.risk_max, b.any_line_over ?? null, b.sequence, b.active, req.params.id);
  audit('approval_rule', Number(req.params.id), req.user, 'updated', `rule updated`);
  res.json({ ok: true });
});
r.delete('/approval-rules/:id', requireRole('admin'), (req, res) => { db.prepare('DELETE FROM approval_rules WHERE id=?').run(req.params.id); res.json({ ok: true }); });

/* ---- warehouses & stock ---- */
r.get('/warehouses', requireInternal, (_q, res) => {
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const stock = db.prepare(`SELECT s.*, p.name product_name, p.sku, w.name warehouse_name FROM stock_levels s
    JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id WHERE p.active=1 ORDER BY p.name`).all();
  res.json({ warehouses, stock });
});
r.post('/warehouses', requireRole('admin', 'finance'), (req, res) => {
  const { name, code, shipping_cost_weight, address } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'Name and code required' });
  try {
    const info = db.prepare('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)').run(name, code, shipping_cost_weight || 1, address || '');
    audit('warehouse', Number(info.lastInsertRowid), req.user, 'created', `${name}`);
    res.json({ warehouse: db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(info.lastInsertRowid)) });
  } catch { res.status(400).json({ error: 'Warehouse code already exists' }); }
});
r.put('/warehouses/:id', requireRole('admin', 'finance'), (req, res) => {
  const { name, shipping_cost_weight, active } = req.body || {};
  db.prepare('UPDATE warehouses SET name=COALESCE(?,name), shipping_cost_weight=COALESCE(?,shipping_cost_weight), active=COALESCE(?,active) WHERE id=?')
    .run(name, shipping_cost_weight, active, req.params.id);
  res.json({ ok: true });
});
r.post('/warehouses/:id/restock', requireRole('admin', 'finance'), (req, res) => {
  const { product_id, qty } = req.body || {};
  if (!product_id || !qty) return res.status(400).json({ error: 'product_id and qty required' });
  db.prepare(`INSERT INTO stock_levels(warehouse_id,product_id,qty) VALUES(?,?,?)
    ON CONFLICT(warehouse_id,product_id) DO UPDATE SET qty = qty + excluded.qty`).run(req.params.id, product_id, qty);
  audit('stock', Number(req.params.id), req.user, 'restock', `+${qty} units of product ${product_id}`);
  res.json({ ok: true });
});
r.put('/stock/:id', requireRole('admin', 'finance'), (req, res) => {
  const { qty, reorder_point, replenishment_qty } = req.body || {};
  db.prepare('UPDATE stock_levels SET qty=COALESCE(?,qty), reorder_point=COALESCE(?,reorder_point), replenishment_qty=COALESCE(?,replenishment_qty) WHERE id=?')
    .run(qty, reorder_point, replenishment_qty, req.params.id);
  res.json({ ok: true });
});

/* ---- subscription plans ---- */
r.get('/plans', requireInternal, (_q, res) => {
  res.json({
    plans: db.prepare('SELECT * FROM subscription_plans ORDER BY name').all(),
    product_plans: db.prepare(`SELECT pp.*, p.name product_name, sp.name plan_name FROM product_plans pp
      JOIN products p ON p.id=pp.product_id JOIN subscription_plans sp ON sp.id=pp.plan_id`).all(),
  });
});
r.post('/plans', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.billing_period) return res.status(400).json({ error: 'Name and billing period required' });
  const info = db.prepare('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)')
    .run(b.name, b.billing_period, b.proration_rule || 'daily', b.cancellation_policy || 'refund_prorated', b.refund_pct || 0, b.notice_days || 0);
  audit('plan', Number(info.lastInsertRowid), req.user, 'created', `${b.name} (${b.billing_period})`);
  res.json({ plan: db.prepare('SELECT * FROM subscription_plans WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.put('/plans/:id', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE subscription_plans SET name=COALESCE(?,name),billing_period=COALESCE(?,billing_period),proration_rule=COALESCE(?,proration_rule),cancellation_policy=COALESCE(?,cancellation_policy),refund_pct=COALESCE(?,refund_pct),notice_days=COALESCE(?,notice_days),active=COALESCE(?,active) WHERE id=?')
    .run(b.name, b.billing_period, b.proration_rule, b.cancellation_policy, b.refund_pct, b.notice_days, b.active, req.params.id);
  res.json({ ok: true });
});
r.post('/product-plans', requireRole('admin'), (req, res) => {
  const { product_id, plan_id, recurring_price } = req.body || {};
  if (!product_id || !plan_id) return res.status(400).json({ error: 'product and plan required' });
  db.prepare(`INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)
    ON CONFLICT(product_id,plan_id) DO UPDATE SET recurring_price=excluded.recurring_price`).run(product_id, plan_id, recurring_price || 0);
  res.json({ ok: true });
});

/* ---- upsell rules ---- */
r.get('/upsell-rules', requireInternal, (_q, res) => {
  res.json({ rules: db.prepare(`SELECT u.*, a.name trigger_name, b.name suggested_name FROM upsell_rules u
    JOIN products a ON a.id=u.trigger_product_id JOIN products b ON b.id=u.suggested_product_id ORDER BY u.co_score DESC`).all() });
});
r.post('/upsell-rules', requireRole('admin', 'manager'), (req, res) => {
  const { trigger_product_id, suggested_product_id, co_score, source } = req.body || {};
  if (!trigger_product_id || !suggested_product_id) return res.status(400).json({ error: 'Trigger and suggested products required' });
  db.prepare(`INSERT INTO upsell_rules(trigger_product_id,suggested_product_id,co_score,source) VALUES(?,?,?,?)
    ON CONFLICT(trigger_product_id,suggested_product_id) DO UPDATE SET co_score=excluded.co_score, active=1`)
    .run(trigger_product_id, suggested_product_id, co_score || 0.5, source || 'manual');
  audit('upsell_rule', 0, req.user, 'created', `rule ${trigger_product_id}→${suggested_product_id}`);
  res.json({ ok: true });
});
r.put('/upsell-rules/:id', requireRole('admin', 'manager'), (req, res) => {
  const { co_score, active } = req.body || {};
  db.prepare('UPDATE upsell_rules SET co_score=COALESCE(?,co_score), active=COALESCE(?,active) WHERE id=?').run(co_score, active, req.params.id);
  res.json({ ok: true });
});
r.delete('/upsell-rules/:id', requireRole('admin', 'manager'), (req, res) => { db.prepare('DELETE FROM upsell_rules WHERE id=?').run(req.params.id); res.json({ ok: true }); });

/* ---- settings ---- */
r.get('/settings', requireInternal, (_q, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = {}; for (const row of rows) s[row.key] = row.value;
  res.json({ settings: s });
});
r.put('/settings', requireRole('admin'), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v);
  audit('settings', 0, req.user, 'updated', Object.keys(req.body || {}).join(', '));
  res.json({ ok: true });
});

/* ---- audit log ---- */
r.get('/audit', requireInternal, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const rows = req.query.entity
    ? db.prepare('SELECT * FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT ?').all(req.query.entity, req.query.entity_id, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ entries: rows });
});

module.exports = r;
