/* DealFlow360 — backend configuration routes (catalog, pricing, governance, warehouses, plans, upsell, settings) (PostgreSQL, async) */
'use strict';
const express = require('express');
const { Q, ONE, RUN, getSetting, setSetting } = require('../db');
const { requireRole, requireInternal } = require('../util');
const { audit } = require('../engines');

const r = express.Router();

/* ---- catalog: categories ---- */
r.get('/categories', requireInternal, async (_q, res) => res.json({ categories: await Q('SELECT * FROM categories ORDER BY name') }));
r.post('/categories', requireRole('admin'), async (req, res) => {
  const { name, discount_ceiling } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const info = await RUN('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', [name, discount_ceiling ?? 20]);
  await audit('category', info.lastInsertRowid, req.user, 'created', `${name} (ceiling ${discount_ceiling}%)`);
  res.json({ category: await ONE('SELECT * FROM categories WHERE id=?', [info.lastInsertRowid]) });
});
r.put('/categories/:id', requireRole('admin'), async (req, res) => {
  const { name, discount_ceiling } = req.body || {};
  await RUN('UPDATE categories SET name=COALESCE(?,name), discount_ceiling=COALESCE(?,discount_ceiling) WHERE id=?', [name, discount_ceiling, req.params.id]);
  await audit('category', Number(req.params.id), req.user, 'updated', `ceiling → ${discount_ceiling}`);
  res.json({ ok: true });
});

/* ---- catalog: products (+variants) ---- */
r.get('/products', requireInternal, async (_q, res) => {
  const products = await Q(`SELECT p.*, c.name category_name, c.discount_ceiling FROM products p JOIN categories c ON c.id=p.category_id ORDER BY c.name, p.name`);
  const variants = await Q('SELECT * FROM product_variants ORDER BY product_id, id');
  const plans = await Q(`SELECT pp.*, sp.name plan_name, sp.billing_period FROM product_plans pp JOIN subscription_plans sp ON sp.id=pp.plan_id`);
  res.json({ products, variants, plans });
});
r.post('/products', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.sku || !b.category_id) return res.status(400).json({ error: 'Name, SKU and category are required' });
  try {
    const info = await RUN(`INSERT INTO products(name,sku,category_id,product_type,base_price,cost_price,unit,tax_rate,description,promoted,stocked)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [b.name, b.sku, b.category_id, b.product_type || 'one_time', b.base_price || 0, b.cost_price || 0, b.unit || 'units', b.tax_rate || 0, b.description || '', b.promoted ? true : false, b.stocked === 0 || b.stocked === false ? false : true]);
    await audit('product', info.lastInsertRowid, req.user, 'created', `${b.sku} ${b.name}`);
    res.json({ product: await ONE('SELECT * FROM products WHERE id=?', [info.lastInsertRowid]) });
  } catch (e) { res.status(400).json({ error: 'SKU already exists' }); }
});
r.put('/products/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  await RUN(`UPDATE products SET name=COALESCE(?,name), base_price=COALESCE(?,base_price), cost_price=COALESCE(?,cost_price),
    tax_rate=COALESCE(?,tax_rate), description=COALESCE(?,description), promoted=COALESCE(?,promoted), active=COALESCE(?,active),
    category_id=COALESCE(?,category_id), stocked=COALESCE(?,stocked) WHERE id=?`,
    [b.name, b.base_price, b.cost_price, b.tax_rate, b.description, b.promoted, b.active, b.category_id, b.stocked, req.params.id]);
  await audit('product', Number(req.params.id), req.user, 'updated', `product updated`);
  res.json({ ok: true });
});
r.post('/products/:id/variants', requireRole('admin'), async (req, res) => {
  const { attribute, value, extra_price } = req.body || {};
  if (!attribute || !value) return res.status(400).json({ error: 'Attribute and value required' });
  const info = await RUN('INSERT INTO product_variants(product_id,attribute,value,extra_price) VALUES(?,?,?,?)', [req.params.id, attribute, value, extra_price || 0]);
  await audit('product', Number(req.params.id), req.user, 'variant_added', `${attribute}: ${value} (+${extra_price || 0})`);
  res.json({ variant: await ONE('SELECT * FROM product_variants WHERE id=?', [info.lastInsertRowid]) });
});
r.delete('/variants/:id', requireRole('admin'), async (req, res) => {
  await RUN('DELETE FROM product_variants WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

/* ---- price lists ---- */
r.get('/price-lists', requireInternal, async (_q, res) => res.json({ price_lists: await Q('SELECT * FROM price_lists ORDER BY name') }));
r.post('/price-lists', requireRole('admin'), async (req, res) => {
  const { name, customer_tier, currency, rule_type, value } = req.body || {};
  if (!name || !customer_tier) return res.status(400).json({ error: 'Name and tier required' });
  const info = await RUN('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)',
    [name, customer_tier, currency || 'USD', rule_type || 'discount', value || 0]);
  await audit('price_list', info.lastInsertRowid, req.user, 'created', `${name}`);
  res.json({ price_list: await ONE('SELECT * FROM price_lists WHERE id=?', [info.lastInsertRowid]) });
});
r.put('/price-lists/:id', requireRole('admin'), async (req, res) => {
  const { name, customer_tier, currency, rule_type, value, active } = req.body || {};
  await RUN('UPDATE price_lists SET name=COALESCE(?,name),customer_tier=COALESCE(?,customer_tier),currency=COALESCE(?,currency),rule_type=COALESCE(?,rule_type),value=COALESCE(?,value),active=COALESCE(?,active) WHERE id=?',
    [name, customer_tier, currency, rule_type, value, active, req.params.id]);
  res.json({ ok: true });
});
r.delete('/price-lists/:id', requireRole('admin'), async (req, res) => { await RUN('DELETE FROM price_lists WHERE id=?', [req.params.id]); res.json({ ok: true }); });

/* ---- discount governance: tiers + approval chain ---- */
r.get('/governance', requireInternal, async (_q, res) => {
  res.json({
    discount_tiers: await Q('SELECT * FROM discount_tiers ORDER BY max_discount_pct'),
    approval_rules: await Q('SELECT * FROM approval_rules ORDER BY sequence'),
  });
});
r.put('/discount-tiers/:tier', requireRole('admin'), async (req, res) => {
  const { max_discount_pct } = req.body || {};
  await RUN('UPDATE discount_tiers SET max_discount_pct=? WHERE customer_tier=?', [max_discount_pct, req.params.tier]);
  await audit('discount_tier', 0, req.user, 'updated', `${req.params.tier} ceiling → ${max_discount_pct}%`);
  res.json({ ok: true });
});
r.post('/approval-rules', requireRole('admin'), async (req, res) => {
  const { name, level, risk_min, risk_max, any_line_over, sequence } = req.body || {};
  const info = await RUN('INSERT INTO approval_rules(name,level,risk_min,risk_max,any_line_over,sequence) VALUES(?,?,?,?,?,?)',
    [name, level, risk_min ?? 0, risk_max ?? 999, any_line_over ?? null, sequence ?? 1]);
  await audit('approval_rule', info.lastInsertRowid, req.user, 'created', name);
  res.json({ rule: await ONE('SELECT * FROM approval_rules WHERE id=?', [info.lastInsertRowid]) });
});
r.put('/approval-rules/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  await RUN('UPDATE approval_rules SET name=COALESCE(?,name),risk_min=COALESCE(?,risk_min),risk_max=COALESCE(?,risk_max),any_line_over=?,sequence=COALESCE(?,sequence),active=COALESCE(?,active) WHERE id=?',
    [b.name, b.risk_min, b.risk_max, b.any_line_over ?? null, b.sequence, b.active, req.params.id]);
  await audit('approval_rule', Number(req.params.id), req.user, 'updated', `rule updated`);
  res.json({ ok: true });
});
r.delete('/approval-rules/:id', requireRole('admin'), async (req, res) => { await RUN('DELETE FROM approval_rules WHERE id=?', [req.params.id]); res.json({ ok: true }); });

/* ---- warehouses & stock ---- */
r.get('/warehouses', requireInternal, async (_q, res) => {
  const warehouses = await Q('SELECT * FROM warehouses ORDER BY name');
  const stock = await Q(`SELECT s.*, p.name product_name, p.sku, w.name warehouse_name FROM stock_levels s
    JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id WHERE p.active ORDER BY p.name`);
  res.json({ warehouses, stock });
});
r.post('/warehouses', requireRole('admin', 'finance'), async (req, res) => {
  const { name, code, shipping_cost_weight, address } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'Name and code required' });
  try {
    const info = await RUN('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)', [name, code, shipping_cost_weight || 1, address || '']);
    await audit('warehouse', info.lastInsertRowid, req.user, 'created', `${name}`);
    res.json({ warehouse: await ONE('SELECT * FROM warehouses WHERE id=?', [info.lastInsertRowid]) });
  } catch { res.status(400).json({ error: 'Warehouse code already exists' }); }
});
r.put('/warehouses/:id', requireRole('admin', 'finance'), async (req, res) => {
  const { name, shipping_cost_weight, active } = req.body || {};
  await RUN('UPDATE warehouses SET name=COALESCE(?,name), shipping_cost_weight=COALESCE(?,shipping_cost_weight), active=COALESCE(?,active) WHERE id=?',
    [name, shipping_cost_weight, active, req.params.id]);
  res.json({ ok: true });
});
r.post('/warehouses/:id/restock', requireRole('admin', 'finance'), async (req, res) => {
  const { product_id, qty } = req.body || {};
  if (!product_id || !qty) return res.status(400).json({ error: 'product_id and qty required' });
  await RUN(`INSERT INTO stock_levels(warehouse_id,product_id,qty) VALUES(?,?,?)
    ON CONFLICT(warehouse_id,product_id) DO UPDATE SET qty = qty + excluded.qty`, [req.params.id, product_id, qty]);
  await audit('stock', Number(req.params.id), req.user, 'restock', `+${qty} units of product ${product_id}`);
  res.json({ ok: true });
});
r.put('/stock/:id', requireRole('admin', 'finance'), async (req, res) => {
  const { qty, reorder_point, replenishment_qty } = req.body || {};
  await RUN('UPDATE stock_levels SET qty=COALESCE(?,qty), reorder_point=COALESCE(?,reorder_point), replenishment_qty=COALESCE(?,replenishment_qty) WHERE id=?',
    [qty, reorder_point, replenishment_qty, req.params.id]);
  res.json({ ok: true });
});

/* ---- subscription plans ---- */
r.get('/plans', requireInternal, async (_q, res) => {
  res.json({
    plans: await Q('SELECT * FROM subscription_plans ORDER BY name'),
    product_plans: await Q(`SELECT pp.*, p.name product_name, sp.name plan_name FROM product_plans pp
      JOIN products p ON p.id=pp.product_id JOIN subscription_plans sp ON sp.id=pp.plan_id`),
  });
});
r.post('/plans', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.billing_period) return res.status(400).json({ error: 'Name and billing period required' });
  const info = await RUN('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)',
    [b.name, b.billing_period, b.proration_rule || 'daily', b.cancellation_policy || 'refund_prorated', b.refund_pct || 0, b.notice_days || 0]);
  await audit('plan', info.lastInsertRowid, req.user, 'created', `${b.name} (${b.billing_period})`);
  res.json({ plan: await ONE('SELECT * FROM subscription_plans WHERE id=?', [info.lastInsertRowid]) });
});
r.put('/plans/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  await RUN('UPDATE subscription_plans SET name=COALESCE(?,name),billing_period=COALESCE(?,billing_period),proration_rule=COALESCE(?,proration_rule),cancellation_policy=COALESCE(?,cancellation_policy),refund_pct=COALESCE(?,refund_pct),notice_days=COALESCE(?,notice_days),active=COALESCE(?,active) WHERE id=?',
    [b.name, b.billing_period, b.proration_rule, b.cancellation_policy, b.refund_pct, b.notice_days, b.active, req.params.id]);
  res.json({ ok: true });
});
r.post('/product-plans', requireRole('admin'), async (req, res) => {
  const { product_id, plan_id, recurring_price } = req.body || {};
  if (!product_id || !plan_id) return res.status(400).json({ error: 'product and plan required' });
  await RUN(`INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)
    ON CONFLICT(product_id,plan_id) DO UPDATE SET recurring_price=excluded.recurring_price`, [product_id, plan_id, recurring_price || 0]);
  res.json({ ok: true });
});

/* ---- upsell rules ---- */
r.get('/upsell-rules', requireInternal, async (_q, res) => {
  res.json({ rules: await Q(`SELECT u.*, a.name trigger_name, b.name suggested_name FROM upsell_rules u
    JOIN products a ON a.id=u.trigger_product_id JOIN products b ON b.id=u.suggested_product_id ORDER BY u.co_score DESC`) });
});
r.post('/upsell-rules', requireRole('admin', 'manager'), async (req, res) => {
  const { trigger_product_id, suggested_product_id, co_score, source } = req.body || {};
  if (!trigger_product_id || !suggested_product_id) return res.status(400).json({ error: 'Trigger and suggested products required' });
  await RUN(`INSERT INTO upsell_rules(trigger_product_id,suggested_product_id,co_score,source) VALUES(?,?,?,?)
    ON CONFLICT(trigger_product_id,suggested_product_id) DO UPDATE SET co_score=excluded.co_score, active`,
    [trigger_product_id, suggested_product_id, co_score || 0.5, source || 'manual']);
  await audit('upsell_rule', 0, req.user, 'created', `rule ${trigger_product_id}→${suggested_product_id}`);
  res.json({ ok: true });
});
r.put('/upsell-rules/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { co_score, active } = req.body || {};
  await RUN('UPDATE upsell_rules SET co_score=COALESCE(?,co_score), active=COALESCE(?,active) WHERE id=?', [co_score, active, req.params.id]);
  res.json({ ok: true });
});
r.delete('/upsell-rules/:id', requireRole('admin', 'manager'), async (req, res) => { await RUN('DELETE FROM upsell_rules WHERE id=?', [req.params.id]); res.json({ ok: true }); });

/* ---- settings ---- */
r.get('/settings', requireInternal, async (_q, res) => {
  const rows = await Q('SELECT key,value FROM settings');
  const s = {}; for (const row of rows) s[row.key] = row.value;
  res.json({ settings: s });
});
r.put('/settings', requireRole('admin'), async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) await setSetting(k, v);
  await audit('settings', 0, req.user, 'updated', Object.keys(req.body || {}).join(', '));
  res.json({ ok: true });
});

/* ---- audit log ---- */
r.get('/audit', requireInternal, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const rows = req.query.entity
    ? await Q('SELECT * FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT ?', [req.query.entity, req.query.entity_id, limit])
    : await Q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
  res.json({ entries: rows });
});

module.exports = r;
