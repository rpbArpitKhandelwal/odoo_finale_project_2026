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


module.exports = r;
