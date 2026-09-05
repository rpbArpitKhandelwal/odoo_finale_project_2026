/* DealFlow360 — Database layer (node:sqlite, zero external dependencies) */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DF_DB || path.join(DATA_DIR, 'dealflow360.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ---------- password helpers (scrypt, no external deps) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}

/* ---------- schema ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','finance','salesrep','customer')),
  customer_id INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('bronze','silver','gold')),
  currency TEXT NOT NULL DEFAULT 'USD',
  address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  discount_ceiling REAL NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL,
  product_type TEXT NOT NULL DEFAULT 'one_time' CHECK(product_type IN ('one_time','subscription')),
  base_price REAL NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'units',
  tax_rate REAL DEFAULT 0,
  description TEXT DEFAULT '',
  promoted INTEGER DEFAULT 0,
  stocked INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  extra_price REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  customer_tier TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  rule_type TEXT NOT NULL DEFAULT 'discount' CHECK(rule_type IN ('discount','markup')),
  value REAL NOT NULL,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS discount_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_tier TEXT NOT NULL UNIQUE,
  max_discount_pct REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('manager','finance')),
  risk_min REAL NOT NULL,
  risk_max REAL NOT NULL,
  any_line_over REAL,
  sequence INTEGER NOT NULL DEFAULT 1,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  shipping_cost_weight REAL NOT NULL DEFAULT 1.0,
  address TEXT DEFAULT '',
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER DEFAULT 0,
  replenishment_qty INTEGER DEFAULT 0,
  UNIQUE(warehouse_id, product_id)
);
CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly','quarterly','yearly')),
  proration_rule TEXT NOT NULL DEFAULT 'daily' CHECK(proration_rule IN ('daily','none')),
  cancellation_policy TEXT NOT NULL DEFAULT 'refund_prorated' CHECK(cancellation_policy IN ('refund_prorated','refund_pct','none')),
  refund_pct REAL DEFAULT 0,
  notice_days INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS product_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  recurring_price REAL NOT NULL,
  UNIQUE(product_id, plan_id)
);
CREATE TABLE IF NOT EXISTS upsell_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_product_id INTEGER NOT NULL,
  suggested_product_id INTEGER NOT NULL,
  co_score REAL NOT NULL DEFAULT 0.5,
  source TEXT DEFAULT 'history',
  active INTEGER DEFAULT 1,
  UNIQUE(trigger_product_id, suggested_product_id)
);
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  rep_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'USD',
  exchange_rate REAL NOT NULL DEFAULT 1,
  order_discount_pct REAL NOT NULL DEFAULT 0,
  subtotal REAL DEFAULT 0, discount_total REAL DEFAULT 0, tax_total REAL DEFAULT 0,
  total REAL DEFAULT 0, cost_total REAL DEFAULT 0, margin_pct REAL DEFAULT 0,
  risk_score REAL DEFAULT 0, max_violation REAL DEFAULT 0,
  approval_level TEXT DEFAULT 'none',
  valid_until TEXT, expected_delivery TEXT,
  portal_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_activity_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT, sent_at TEXT, confirmed_at TEXT,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS quotation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  variant_id INTEGER,
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  line_type TEXT NOT NULL DEFAULT 'one_time',
  plan_id INTEGER,
  billing_period TEXT,
  sort INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  level TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',
  approver_id INTEGER,
  reason TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fulfillment_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','shipped','backorder')),
  est_cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  shipped_at TEXT
);
CREATE TABLE IF NOT EXISTS billing_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  scheduled_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invoiced','cancelled')),
  invoice_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  quotation_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('one_time','recurring','credit_note')),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','void')),
  due_date TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT DEFAULT 'bank_transfer',
  reference TEXT DEFAULT '',
  paid_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS negotiations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('comment','counter','change_request')),
  message TEXT DEFAULT '',
  proposed_discount REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','declined')),
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('stalled','anomaly','slippage')),
  quotation_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','nudged','escalated','dismissed')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(kind, quotation_id)
);
`;

function getSetting(key, dflt) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : dflt;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

function seed() {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (users > 0) return; // already seeded

  /* --- users --- */
  const insUser = db.prepare('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)');
  insUser.run('Asha Verma', 'rep@dealflow.io', hashPassword('Rep@123'), 'salesrep', null);
  insUser.run('Vikram Singh', 'rep2@dealflow.io', hashPassword('Rep@123'), 'salesrep', null);
  insUser.run('Priya Sharma', 'manager@dealflow.io', hashPassword('Manager@123'), 'manager', null);
  insUser.run('Rahul Mehta', 'finance@dealflow.io', hashPassword('Finance@123'), 'finance', null);
  insUser.run('System Admin', 'admin@dealflow.io', hashPassword('Admin@123'), 'admin', null);

  /* --- customers (+ portal users) --- */
  const insCust = db.prepare('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)');
  const acme = Number(insCust.run('Acme Corp', 'buyer@acmecorp.com', '+1 415 555 0101', 'gold', 'USD', '100 Market St, San Francisco, CA').lastInsertRowid);
  const beta = Number(insCust.run('Beta Industries', 'buyer@betaind.com', '+1 312 555 0142', 'silver', 'USD', '22 Lakeshore Dr, Chicago, IL').lastInsertRowid);
  const gamma = Number(insCust.run('Gamma Retail', 'buyer@gammaretail.in', '+91 98200 11223', 'bronze', 'INR', 'Andheri East, Mumbai, IN').lastInsertRowid);
  const delta = Number(insCust.run('Delta Logistics', 'buyer@deltalog.com', '+1 713 555 0177', 'gold', 'USD', '9 Harbor Blvd, Houston, TX').lastInsertRowid);
  insUser.run('Tom Jacobs (Acme)', 'buyer@acmecorp.com', hashPassword('Customer@123'), 'customer', acme);
  insUser.run('Neha Kulkarni (Gamma)', 'buyer@gammaretail.in', hashPassword('Customer@123'), 'customer', gamma);

  /* --- categories --- */
  const insCat = db.prepare('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)');
  const hw = Number(insCat.run('Hardware', 15).lastInsertRowid);
  const svc = Number(insCat.run('Services', 10).lastInsertRowid);
  const sub = Number(insCat.run('Subscriptions', 12).lastInsertRowid);
  const acc = Number(insCat.run('Accessories', 20).lastInsertRowid);

  /* --- products --- */
  const insProd = db.prepare('INSERT INTO products(name,sku,category_id,product_type,base_price,cost_price,unit,tax_rate,description,promoted,stocked) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const laptop = Number(insProd.run('Laptop Pro 15"', 'LP-15', hw, 'one_time', 1299, 940, 'units', 8, '15" enterprise laptop, i7, 16GB, 512GB SSD', 0, 1).lastInsertRowid);
  const ultra = Number(insProd.run('Laptop Ultra 14"', 'LU-14', hw, 'one_time', 1799, 1310, 'units', 8, '14" ultralight, i9, premium build', 0, 1).lastInsertRowid);
  const monitor = Number(insProd.run('27" 4K Monitor', 'MON-4K27', hw, 'one_time', 449, 290, 'units', 8, '27-inch 4K IPS display', 1, 1).lastInsertRowid);
  const mouse = Number(insProd.run('Wireless Mouse', 'MOU-W1', hw, 'one_time', 59, 22, 'units', 8, 'Ergonomic wireless mouse', 0, 1).lastInsertRowid);
  const kbd = Number(insProd.run('Mechanical Keyboard', 'KBD-M1', hw, 'one_time', 129, 58, 'units', 8, 'Backlit mechanical keyboard', 0, 1).lastInsertRowid);
  const router = Number(insProd.run('Wi-Fi 6 Router', 'RTR-W6', hw, 'one_time', 199, 105, 'units', 8, 'Mesh-capable Wi-Fi 6 router', 0, 1).lastInsertRowid);
  const dock = Number(insProd.run('USB-C Docking Station', 'DOCK-C1', acc, 'one_time', 249, 140, 'units', 8, '12-in-1 USB-C dock', 0, 1).lastInsertRowid);
  const sleeve = Number(insProd.run('Laptop Sleeve', 'SLV-15', acc, 'one_time', 39, 12, 'units', 8, 'Padded 15" sleeve', 0, 1).lastInsertRowid);
  const install = Number(insProd.run('Installation & Setup', 'SVC-INST', svc, 'one_time', 299, 180, 'visit', 10, 'Onsite installation and configuration', 0, 0).lastInsertRowid);
  const training = Number(insProd.run('Onsite Training Day', 'SVC-TRN', svc, 'one_time', 549, 360, 'day', 10, 'Full-day hands-on team training', 0, 0).lastInsertRowid);
  const warranty = Number(insProd.run('Extended Warranty 3yr', 'SVC-WAR3', svc, 'one_time', 219, 90, 'units', 10, '3-year next-business-day warranty', 0, 0).lastInsertRowid);
  const backup = Number(insProd.run('Cloud Backup Pro', 'SUB-BKP', sub, 'subscription', 0, 6, 'users', 5, 'Automated cloud backup, per user', 1, 0).lastInsertRowid);
  const support = Number(insProd.run('Premium Support Plan', 'SUB-SUP', sub, 'subscription', 0, 700, 'units', 5, '24/7 premium support, yearly', 0, 0).lastInsertRowid);
  const security = Number(insProd.run('Security Suite', 'SUB-SEC', sub, 'subscription', 0, 120, 'units', 5, 'Managed endpoint security, quarterly', 1, 0).lastInsertRowid);

  const insVar = db.prepare('INSERT INTO product_variants(product_id,attribute,value,extra_price) VALUES(?,?,?,?)');
  insVar.run(laptop, 'Configuration', 'Standard (16GB/512GB)', 0);
  insVar.run(laptop, 'Configuration', 'Performance (32GB/1TB)', 250);
  insVar.run(laptop, 'Configuration', 'Max (32GB/2TB + dGPU)', 430);
  insVar.run(mouse, 'Pack', 'Single', 0);
  insVar.run(mouse, 'Pack', '3-Pack', 110);

  /* --- price lists --- */
  const insPL = db.prepare('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)');
  insPL.run('Gold Partner Program', 'gold', 'USD', 'discount', 5);
  insPL.run('Silver Partner Pricing', 'silver', 'USD', 'discount', 2);
  insPL.run('India List (INR)', 'bronze', 'INR', 'markup', 4);

  /* --- discount tiers & approval chain --- */
  const insDT = db.prepare('INSERT INTO discount_tiers(customer_tier,max_discount_pct) VALUES(?,?)');
  insDT.run('bronze', 5); insDT.run('silver', 10); insDT.run('gold', 15);
  const insAR = db.prepare('INSERT INTO approval_rules(name,level,risk_min,risk_max,any_line_over,sequence) VALUES(?,?,?,?,?,?)');
  insAR.run('Sales Manager review', 'manager', 0.5, 5, null, 1);
  insAR.run('Manager + Finance review', 'finance', 5.01, 999, 20, 2);

  /* --- warehouses + stock --- */
  const insWH = db.prepare('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)');
  const main = Number(insWH.run('Main Warehouse', 'WH-MAIN', 1.0, 'Denver, CO').lastInsertRowid);
  const east = Number(insWH.run('East Depot', 'WH-EAST', 1.4, 'Newark, NJ').lastInsertRowid);
  const west = Number(insWH.run('West Hub', 'WH-WEST', 1.2, 'Oakland, CA').lastInsertRowid);
  const insStock = db.prepare('INSERT INTO stock_levels(warehouse_id,product_id,qty,reorder_point,replenishment_qty) VALUES(?,?,?,?,?)');
  const stockMap = [
    [laptop, [[main, 8, 4, 10], [east, 6, 3, 10], [west, 4, 2, 10]]],
    [ultra, [[main, 2, 1, 5], [east, 1, 1, 5], [west, 0, 1, 5]]],
    [monitor, [[main, 3, 2, 8], [east, 0, 2, 8], [west, 9, 3, 8]]],
    [mouse, [[main, 50, 10, 50], [east, 20, 10, 50], [west, 0, 10, 50]]],
    [kbd, [[main, 15, 5, 25], [east, 5, 5, 25], [west, 5, 5, 25]]],
    [router, [[main, 4, 3, 12], [east, 10, 3, 12], [west, 3, 3, 12]]],
    [dock, [[main, 6, 2, 10], [east, 2, 2, 10], [west, 2, 2, 10]]],
    [sleeve, [[main, 20, 5, 20], [east, 10, 5, 20], [west, 10, 5, 20]]],
  ];
  for (const [pid, rows] of stockMap) for (const [wid, q, rp, rq] of rows) insStock.run(wid, pid, q, rp, rq);

  /* --- subscription plans --- */
  const insPlan = db.prepare('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)');
  const monthly = Number(insPlan.run('Monthly Essentials', 'monthly', 'daily', 'refund_prorated', 0, 0).lastInsertRowid);
  const quarterly = Number(insPlan.run('Quarterly Value', 'quarterly', 'daily', 'refund_pct', 70, 7).lastInsertRowid);
  const yearly = Number(insPlan.run('Annual Advantage', 'yearly', 'daily', 'refund_pct', 70, 30).lastInsertRowid);
  const insPP = db.prepare('INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)');
  insPP.run(backup, monthly, 29);
  insPP.run(support, yearly, 1999);
  insPP.run(security, quarterly, 399);

  /* --- upsell rules (co-purchase history) --- */
  const insUP = db.prepare('INSERT INTO upsell_rules(trigger_product_id,suggested_product_id,co_score,source) VALUES(?,?,?,?)');
  const upsell = [
    [laptop, mouse, 0.92, 'history'], [laptop, kbd, 0.86, 'history'], [laptop, monitor, 0.81, 'history'],
    [laptop, backup, 0.74, 'history'], [laptop, dock, 0.70, 'history'],
    [ultra, dock, 0.90, 'history'], [ultra, backup, 0.85, 'history'], [ultra, monitor, 0.80, 'history'],
    [router, security, 0.93, 'history'], [router, install, 0.64, 'history'],
    [install, training, 0.82, 'history'], [install, warranty, 0.78, 'history'],
    [monitor, dock, 0.75, 'history'], [mouse, kbd, 0.65, 'history'],
    [backup, security, 0.72, 'history'], [laptop, sleeve, 0.58, 'history'],
  ];
  for (const [t, s, c, src] of upsell) insUP.run(t, s, c, src);

  /* --- settings --- */
  setSetting('stalled_days', 3);
  setSetting('anomaly_multiplier', 1.5);
  setSetting('slippage_days', 2);
  setSetting('usd_inr', 83);
  setSetting('min_margin_pct', 30);
  setSetting('base_ship_cost', 18);
  setSetting('company_name', 'DealFlow360 Inc.');

  /* --- seed quotations for a "lived-in" demo --- */
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
  const daysAhead = (d) => new Date(now + d * 86400000).toISOString();
  const insQ = db.prepare(`INSERT INTO quotations(number,customer_id,rep_id,status,currency,exchange_rate,order_discount_pct,subtotal,discount_total,tax_total,total,cost_total,margin_pct,risk_score,max_violation,approval_level,valid_until,expected_delivery,portal_token,created_at,last_activity_at,submitted_at,sent_at,confirmed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insL = db.prepare(`INSERT INTO quotation_lines(quotation_id,product_id,variant_id,description,qty,unit_price,cost_price,discount_pct,line_type,plan_id,billing_period,sort)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const token = () => crypto.randomBytes(12).toString('hex');

  // QT-1018: OLD draft -> stalled alert (Beta, Vikram)
  let q = insQ.run('QT-1018', beta, 2, 'draft', 'USD', 1, 0, 549, 0, 54.9, 603.9, 360, 40.4, 0, 0, 'none', daysAhead(21), daysAhead(30), token(), daysAgo(12), daysAgo(12), null, null, null);
  insL.run(Number(q.lastInsertRowid), training, null, 'Onsite Training Day', 1, 549, 360, 0, 'one_time', null, null, 0);

  // QT-1010: confirmed with unusually high discount -> anomaly alert (Acme, Asha)
  q = insQ.run('QT-1010', acme, 1, 'confirmed', 'USD', 1, 0, 4387, 695.5, 369.2, 4060.7, 3162, 22.1, 4.8, 4.8, 'manager', daysAgo(25), daysAgo(10), token(), daysAgo(26), daysAgo(20), daysAgo(24), null, daysAgo(24));
  let qid = Number(q.lastInsertRowid);
  insL.run(qid, monitor, null, '27" 4K Monitor', 4, 449, 290, 22, 'one_time', null, null, 0);
  insL.run(qid, mouse, null, 'Wireless Mouse', 6, 59, 22, 18, 'one_time', null, null, 1);
  insL.run(qid, laptop, null, 'Laptop Pro 15"', 2, 1299, 940, 12, 'one_time', null, null, 2);

  // QT-1025: confirmed, delivery slipped (Gamma, Asha) -> slippage alert + open invoice for payment demo
  q = insQ.run('QT-1025', gamma, 1, 'confirmed', 'INR', 83, 0, 26790, 0, 1339.5, 28129.5, 11880, 55.8, 0, 0, 'none', daysAgo(6), daysAgo(5), token(), daysAgo(8), daysAgo(4), daysAgo(8), null, daysAgo(7));
  qid = Number(q.lastInsertRowid);
  insL.run(qid, sleeve, null, 'Laptop Sleeve', 30, 39 * 4.32, 12 * 4.32, 0, 'one_time', null, null, 0); // INR approx
  insL.run(qid, dock, null, 'USB-C Docking Station', 5, 249 * 4.32, 140 * 4.32, 0, 'one_time', null, null, 1);

  // QT-1032: sent to portal (Delta, Asha) -> negotiation demo
  q = insQ.run('QT-1032', delta, 1, 'sent', 'USD', 1, 0, 1073, 0, 53.65, 1126.65, 852.8, 20.4, 0, 0, 'none', daysAhead(15), daysAhead(7), token(), daysAgo(4), daysAgo(1), null, daysAgo(2), null);
  qid = Number(q.lastInsertRowid);
  insL.run(qid, backup, null, 'Cloud Backup Pro (per user/mo)', 25, 29, 6, 10, 'subscription', monthly, 'monthly', 0);
  insL.run(qid, laptop, null, 'Laptop Pro 15"', 1, 1299, 940, 5, 'one_time', null, null, 1);

  // QT-1039: confirmed & fulfilled with paid invoices (Gamma, Vikram) -> reporting baseline
  q = insQ.run('QT-1039', gamma, 2, 'fulfilled', 'INR', 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'none', daysAgo(3), daysAgo(2), token(), daysAgo(18), daysAgo(12), daysAgo(18), null, daysAgo(17));
  qid = Number(q.lastInsertRowid);
  insL.run(qid, mouse, null, 'Wireless Mouse (3-Pack)', 5, (59 + 110) * 4.32, 66 * 4.32, 0, 'one_time', null, null, 0);
  insL.run(qid, kbd, null, 'Mechanical Keyboard', 10, 129 * 4.32, 58 * 4.32, 0, 'one_time', null, null, 1);
  insL.run(qid, security, null, 'Security Suite (per qtr)', 4, 399 * 4.32, 120 * 4.32, 0, 'subscription', quarterly, 'quarterly', 2);

  // more historical confirmed quotes (baseline for anomaly stats)
  const hist = [
    ['QT-1004', acme, 1, 6, 0, 'fulfilled'],
    ['QT-1007', beta, 2, 11, 3, 'fulfilled'],
    ['QT-1012', acme, 1, 8, 2, 'fulfilled'],
    ['QT-1015', delta, 1, 5, 1, 'fulfilled'],
  ];
  for (const [num, cust, rep, dAgo, disc, status] of hist) {
    const sub = 2500 + Math.round(Math.random() * 1800);
    const discTotal = sub * disc / 100;
    const tax = (sub - discTotal) * 0.08;
    const cost = (sub - discTotal) * 0.62;
    const tot = sub - discTotal + tax;
    q = insQ.run(num, cust, rep, status, 'USD', 1, 0, sub, discTotal, tax, tot, cost, ((tot - cost) / tot * 100), 0, 0, 'none', daysAgo(dAgo - 5), daysAgo(dAgo + 2), token(), daysAgo(dAgo + 1), daysAgo(dAgo), daysAgo(dAgo), null, daysAgo(dAgo));
    qid = Number(q.lastInsertRowid);
    insL.run(qid, laptop, null, 'Laptop Pro 15"', 1, 1299, 940, disc, 'one_time', null, null, 0);
    insL.run(qid, mouse, null, 'Wireless Mouse', 2, 59, 22, disc, 'one_time', null, null, 1);
  }

  // QT-1041: pending manager approval (Beta, Asha)
  q = insQ.run('QT-1041', beta, 1, 'pending_manager', 'USD', 1, 0, 3292, 63, 258.3, 3487.3, 2260, 35.2, 4, 4, 'manager', daysAhead(10), daysAhead(6), token(), daysAgo(2), daysAgo(1), daysAgo(1), null, null);
  qid = Number(q.lastInsertRowid);
  insL.run(qid, monitor, null, '27" 4K Monitor', 6, 449, 290, 14, 'one_time', null, null, 0);
  insL.run(qid, router, null, 'Wi-Fi 6 Router', 2, 199, 105, 8, 'one_time', null, null, 1);
  const appr = db.prepare('INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,?,?)');
  appr.run(qid, 'manager', 1, 'pending');
  db.prepare('INSERT INTO audit_log(entity,entity_id,user_id,user_name,action,details) VALUES(?,?,?,?,?,?)')
    .run('quotation', qid, 1, 'Asha Verma', 'submitted_for_approval', 'Auto-routed to Sales Manager (blended risk 4.0)');

  // invoices + payments for fulfilled quotes
  const insInv = db.prepare('INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const insPay = db.prepare('INSERT INTO payments(invoice_id,amount,method,reference,paid_at) VALUES(?,?,?,?,?)');
  const insFS = db.prepare('INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost,shipped_at) VALUES(?,?,?,?,?,?,?)');
  const insBS = db.prepare('INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id) VALUES(?,?,?,?,?,?,?)');

  // QT-1039 (Gamma): one-time invoice paid, recurring schedule + first paid
  const q1039 = db.prepare('SELECT id FROM quotations WHERE number=?').get('QT-1039');
  const l1039 = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?', ).all(q1039.id);
  const oneTimeAmount = l1039.filter(l => l.line_type === 'one_time').reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100), 0);
  const inv1 = Number(insInv.run('INV-2031', q1039.id, gamma, 'one_time', Math.round(oneTimeAmount * 1.05), 'paid', daysAgo(16), daysAgo(15), daysAgo(17)).lastInsertRowid);
  insPay.run(inv1, Math.round(oneTimeAmount * 1.05), 'bank_transfer', 'TXN-88121', daysAgo(15));
  const secLine = l1039.find(l => l.line_type === 'subscription');
  if (secLine) {
    const inv2 = Number(insInv.run('INV-2032', q1039.id, gamma, 'recurring', Math.round(secLine.qty * secLine.unit_price * 1.05), 'paid', daysAgo(16), daysAgo(15), daysAgo(17)).lastInsertRowid);
    insPay.run(inv2, Math.round(secLine.qty * secLine.unit_price * 1.05), 'bank_transfer', 'TXN-88122', daysAgo(15));
    for (let i = 1; i <= 4; i++) {
      const d = new Date(now + i * 90 * 86400000).toISOString();
      insBS.run(q1039.id, secLine.id, d, `Security Suite — cycle ${i + 1} (4 units)`, secLine.qty * secLine.unit_price, 'scheduled', null);
    }
  }
  for (const l of l1039.filter(l => l.line_type === 'one_time')) {
    insFS.run(q1039.id, l.id, main, l.qty, 'shipped', 18, daysAgo(12));
  }

  // QT-1025 (Gamma slippage): open invoice -> payment demo target
  const q1025 = db.prepare('SELECT id FROM quotations WHERE number=?').get('QT-1025');
  const l1025 = db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=?').all(q1025.id);
  const amt1025 = Math.round(l1025.reduce((s, l) => s + l.qty * l.unit_price, 0) * 1.05);
  insInv.run('INV-2044', q1025.id, gamma, 'one_time', amt1025, 'open', daysAhead(9), null, daysAgo(6));
  for (const l of l1025) insFS.run(q1025.id, l.id, main, Math.ceil(l.qty / 2), 'shipped', 18, daysAgo(4));
  insFS.run(q1025.id, l1025[1].id, main, l1025[1].qty - Math.ceil(l1025[1].qty / 2), 'backorder', 0);

  // QT-1010 paid invoice
  const q1010 = db.prepare('SELECT id FROM quotations WHERE number=?').get('QT-1010');
  const inv1010 = Number(insInv.run('INV-2018', q1010.id, acme, 'one_time', 4060.7, 'paid', daysAgo(23), daysAgo(22), daysAgo(24)).lastInsertRowid);
  insPay.run(inv1010, 4060.7, 'card', 'TXN-87901', daysAgo(22));

  // QT-1004/1007/1012/1015 paid invoices (baseline reporting)
  const paidHist = [['QT-1004', acme], ['QT-1007', beta], ['QT-1012', acme], ['QT-1015', delta]];
  let invNo = 2010;
  for (const [num, cust] of paidHist) {
    const qq = db.prepare('SELECT id, total FROM quotations WHERE number=?').get(num);
    const inv = Number(insInv.run(`INV-${invNo++}`, qq.id, cust, 'one_time', Math.round(qq.total), 'paid', null, null, daysAgo(5)).lastInsertRowid);
    insPay.run(inv, Math.round(qq.total), 'bank_transfer', `TXN-${88000 + invNo}`, daysAgo(4));
  }
}

db.exec(SCHEMA);
seed();

module.exports = { db, hashPassword, verifyPassword, getSetting, setSetting };
