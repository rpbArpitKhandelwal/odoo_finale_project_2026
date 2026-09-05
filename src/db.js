/* DealFlow360 — Database layer (PostgreSQL via node-postgres) */
'use strict';
const { Pool } = require('pg');
const crypto = require('crypto');

/* ---------- connection ---------- */
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'dealflow',
  password: process.env.PGPASSWORD || 'DealFlow@2026',
  database: process.env.PGDATABASE || 'dealflow360',
  max: 12,
});

/* Keep numeric types as JS numbers (COUNT(*) → int8, SUM/AVG → numeric come back as strings otherwise) */
const pgTypes = require('pg').types;
pgTypes.setTypeParser(20, (v) => parseInt(v, 10));     // int8  (COUNT)
pgTypes.setTypeParser(1700, (v) => parseFloat(v));     // numeric (SUM/AVG)
pgTypes.setTypeParser(700, (v) => parseFloat(v));      // float4

/* ---------- SQL helpers ----------
 * The app was born on SQLite; this wrapper keeps the `?` placeholder style,
 * appends RETURNING id for INSERTs and exposes a tiny async API:
 *   Q(sql, params)   → rows[]
 *   ONE(sql, params) → row | null
 *   RUN(sql, params) → { lastInsertRowid, changes }
 *   TX(async fn)     → transaction on a dedicated client
 */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
async function Q(sql, params = [], client) {
  const c = client || pool;
  const r = await c.query(toPg(sql), params);
  return r.rows;
}
async function ONE(sql, params = [], client) {
  const rows = await Q(sql, params, client);
  return rows[0] || null;
}
/* Tables whose primary key is not `id` — INSERTs into them must not get RETURNING id appended */
const NO_ID_TABLES = new Set(['settings', 'sessions']);
async function RUN(sql, params = [], client) {
  const c = client || pool;
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-zA-Z_]+)/i.exec(sql);
  const isInsert = !!m;
  const hasId = m ? !NO_ID_TABLES.has(m[1].toLowerCase()) : false;
  if (isInsert && hasId && !/\bRETURNING\b/i.test(sql)) {
    const r = await c.query(toPg(`${sql.trimEnd().replace(/;+\s*$/, '')} RETURNING id`), params);
    return { lastInsertRowid: Number(r.rows[0]?.id ?? 0), changes: r.rowCount || 0 };
  }
  const r = await c.query(toPg(sql), params);
  return { lastInsertRowid: 0, changes: r.rowCount || 0 };
}
async function TX(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* Timestamps are stored as TEXT in ISO-8601 UTC (identical shape to the previous
 * SQLite layer), so JS-side string comparisons and the frontend keep working. */
const NOW_ISO = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const TODAY = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

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
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','finance','salesrep','customer')),
  customer_id INTEGER,
  sales_team TEXT NOT NULL DEFAULT 'Direct',
  active SMALLINT DEFAULT 1,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (${NOW_ISO}),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('bronze','silver','gold')),
  currency TEXT NOT NULL DEFAULT 'USD',
  address TEXT,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  discount_ceiling DOUBLE PRECISION NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL,
  product_type TEXT NOT NULL DEFAULT 'one_time' CHECK(product_type IN ('one_time','subscription')),
  base_price DOUBLE PRECISION NOT NULL,
  cost_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'units',
  tax_rate DOUBLE PRECISION DEFAULT 0,
  description TEXT DEFAULT '',
  promoted SMALLINT DEFAULT 0,
  stocked SMALLINT DEFAULT 1,
  active SMALLINT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  extra_price DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS price_lists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  customer_tier TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  rule_type TEXT NOT NULL DEFAULT 'discount' CHECK(rule_type IN ('discount','markup')),
  value DOUBLE PRECISION NOT NULL,
  active SMALLINT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS discount_tiers (
  id SERIAL PRIMARY KEY,
  customer_tier TEXT NOT NULL UNIQUE,
  max_discount_pct DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('manager','finance')),
  risk_min DOUBLE PRECISION NOT NULL,
  risk_max DOUBLE PRECISION NOT NULL,
  any_line_over DOUBLE PRECISION,
  sequence INTEGER NOT NULL DEFAULT 1,
  active SMALLINT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  shipping_cost_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  address TEXT DEFAULT '',
  active SMALLINT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_levels (
  id SERIAL PRIMARY KEY,
  warehouse_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER DEFAULT 0,
  replenishment_qty INTEGER DEFAULT 0,
  UNIQUE(warehouse_id, product_id)
);
CREATE TABLE IF NOT EXISTS subscription_plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly','quarterly','yearly')),
  proration_rule TEXT NOT NULL DEFAULT 'daily' CHECK(proration_rule IN ('daily','none')),
  cancellation_policy TEXT NOT NULL DEFAULT 'refund_prorated' CHECK(cancellation_policy IN ('refund_prorated','refund_pct','none')),
  refund_pct DOUBLE PRECISION DEFAULT 0,
  notice_days INTEGER DEFAULT 0,
  active SMALLINT DEFAULT 1
);
CREATE TABLE IF NOT EXISTS product_plans (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  recurring_price DOUBLE PRECISION NOT NULL,
  UNIQUE(product_id, plan_id)
);
CREATE TABLE IF NOT EXISTS upsell_rules (
  id SERIAL PRIMARY KEY,
  trigger_product_id INTEGER NOT NULL,
  suggested_product_id INTEGER NOT NULL,
  co_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  source TEXT DEFAULT 'history',
  active SMALLINT DEFAULT 1,
  UNIQUE(trigger_product_id, suggested_product_id)
);
CREATE TABLE IF NOT EXISTS quotations (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  rep_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'USD',
  exchange_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
  order_discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  subtotal DOUBLE PRECISION DEFAULT 0, discount_total DOUBLE PRECISION DEFAULT 0, tax_total DOUBLE PRECISION DEFAULT 0,
  total DOUBLE PRECISION DEFAULT 0, cost_total DOUBLE PRECISION DEFAULT 0, margin_pct DOUBLE PRECISION DEFAULT 0,
  risk_score DOUBLE PRECISION DEFAULT 0, max_violation DOUBLE PRECISION DEFAULT 0,
  approval_level TEXT DEFAULT 'none',
  valid_until TEXT, expected_delivery TEXT,
  portal_token TEXT,
  dismissed_suggestions TEXT DEFAULT '',
  created_at TEXT DEFAULT (${NOW_ISO}),
  last_activity_at TEXT DEFAULT (${NOW_ISO}),
  submitted_at TEXT, sent_at TEXT, confirmed_at TEXT,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS quotation_lines (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  variant_id INTEGER,
  description TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 1,
  unit_price DOUBLE PRECISION NOT NULL,
  cost_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  line_type TEXT NOT NULL DEFAULT 'one_time',
  plan_id INTEGER,
  billing_period TEXT,
  sort INTEGER DEFAULT 0,
  dismissed SMALLINT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL,
  level TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',
  approver_id INTEGER,
  reason TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS fulfillment_splits (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','shipped','backorder')),
  est_cost DOUBLE PRECISION DEFAULT 0,
  created_at TEXT DEFAULT (${NOW_ISO}),
  shipped_at TEXT
);
CREATE TABLE IF NOT EXISTS billing_schedule (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  scheduled_date TEXT NOT NULL,
  description TEXT,
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invoiced','cancelled')),
  invoice_id INTEGER,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  quotation_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('one_time','recurring','credit_note')),
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','void')),
  due_date TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT DEFAULT 'bank_transfer',
  reference TEXT DEFAULT '',
  paid_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS negotiations (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL,
  line_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('comment','counter','change_request')),
  message TEXT DEFAULT '',
  proposed_discount DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','declined')),
  created_at TEXT DEFAULT (${NOW_ISO}),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('stalled','anomaly','slippage')),
  quotation_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','nudged','escalated','dismissed')),
  created_at TEXT DEFAULT (${NOW_ISO}),
  updated_at TEXT DEFAULT (${NOW_ISO}),
  UNIQUE(kind, quotation_id)
);
CREATE TABLE IF NOT EXISTS commission_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','salesperson','team','category','product')),
  salesperson_id INTEGER,
  team TEXT,
  category_id INTEGER,
  product_id INTEGER,
  rate_type TEXT NOT NULL DEFAULT 'percentage' CHECK(rate_type IN ('percentage','fixed','margin_tier')),
  rate DOUBLE PRECISION NOT NULL DEFAULT 3,
  margin_tiers JSONB,
  active SMALLINT DEFAULT 1,
  created_at TEXT DEFAULT (${NOW_ISO})
);
CREATE TABLE IF NOT EXISTS commissions (
  id SERIAL PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  quotation_id INTEGER NOT NULL,
  invoice_id INTEGER,
  salesperson_id INTEGER NOT NULL,
  base_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  margin_pct DOUBLE PRECISION DEFAULT 0,
  rule_id INTEGER,
  rule_name TEXT,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate_type TEXT NOT NULL DEFAULT 'percentage',
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','approved','paid')),
  period TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'),
  created_at TEXT DEFAULT (${NOW_ISO}),
  confirmed_at TEXT, approved_at TEXT, paid_at TEXT,
  notes TEXT DEFAULT ''
);
`;

async function getSetting(key, dflt, client) {
  const row = await ONE('SELECT value FROM settings WHERE key=?', [key], client);
  return row ? row.value : dflt;
}
async function setSetting(key, value, client) {
  await RUN(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, String(value)], client);
}

/* ---------- seed ---------- */
async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int c FROM users');
  if (rows[0].c > 0) return; // already seeded

  await TX(async (c) => {
    const run = (sql, ...p) => RUN(sql, p, c);
    const one = (sql, ...p) => ONE(sql, p, c);

    /* --- users --- */
    const uAsha = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Asha Verma', 'rep@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'Enterprise')).lastInsertRowid;
    const uVikram = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Vikram Singh', 'rep2@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'SMB')).lastInsertRowid;
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Priya Sharma', 'manager@dealflow.io', hashPassword('Manager@123'), 'manager', 'Enterprise');
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Rahul Mehta', 'finance@dealflow.io', hashPassword('Finance@123'), 'finance', 'Finance');
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'System Admin', 'admin@dealflow.io', hashPassword('Admin@123'), 'admin', 'Direct');

    /* --- customers (+ portal users) --- */
    const acme = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Acme Corp', 'buyer@acmecorp.com', '+1 415 555 0101', 'gold', 'USD', '100 Market St, San Francisco, CA')).lastInsertRowid;
    const beta = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Beta Industries', 'buyer@betaind.com', '+1 312 555 0142', 'silver', 'USD', '22 Lakeshore Dr, Chicago, IL')).lastInsertRowid;
    const gamma = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Gamma Retail', 'buyer@gammaretail.in', '+91 98200 11223', 'bronze', 'INR', 'Andheri East, Mumbai, IN')).lastInsertRowid;
    const delta = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Delta Logistics', 'buyer@deltalog.com', '+1 713 555 0177', 'gold', 'USD', '9 Harbor Blvd, Houston, TX')).lastInsertRowid;
    await run('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)', 'Tom Jacobs (Acme)', 'buyer@acmecorp.com', hashPassword('Customer@123'), 'customer', acme);
    await run('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)', 'Neha Kulkarni (Gamma)', 'buyer@gammaretail.in', hashPassword('Customer@123'), 'customer', gamma);

    /* --- categories --- */
    const hw = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Hardware', 15)).lastInsertRowid;
    const svc = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Services', 10)).lastInsertRowid;
    const sub = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Subscriptions', 12)).lastInsertRowid;
    const acc = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Accessories', 20)).lastInsertRowid;

    /* --- products --- */
    const insP = 'INSERT INTO products(name,sku,category_id,product_type,base_price,cost_price,unit,tax_rate,description,promoted,stocked) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
    const laptop = (await run(insP, 'Laptop Pro 15"', 'LP-15', hw, 'one_time', 1299, 940, 'units', 8, '15" enterprise laptop, i7, 16GB, 512GB SSD', 0, 1)).lastInsertRowid;
    const ultra = (await run(insP, 'Laptop Ultra 14"', 'LU-14', hw, 'one_time', 1799, 1310, 'units', 8, '14" ultralight, i9, premium build', 0, 1)).lastInsertRowid;
    const monitor = (await run(insP, '27" 4K Monitor', 'MON-4K27', hw, 'one_time', 449, 290, 'units', 8, '27-inch 4K IPS display', 1, 1)).lastInsertRowid;
    const mouse = (await run(insP, 'Wireless Mouse', 'MOU-W1', hw, 'one_time', 59, 22, 'units', 8, 'Ergonomic wireless mouse', 0, 1)).lastInsertRowid;
    const kbd = (await run(insP, 'Mechanical Keyboard', 'KBD-M1', hw, 'one_time', 129, 58, 'units', 8, 'Backlit mechanical keyboard', 0, 1)).lastInsertRowid;
    const router = (await run(insP, 'Wi-Fi 6 Router', 'RTR-W6', hw, 'one_time', 199, 105, 'units', 8, 'Mesh-capable Wi-Fi 6 router', 0, 1)).lastInsertRowid;
    const dock = (await run(insP, 'USB-C Docking Station', 'DOCK-C1', acc, 'one_time', 249, 140, 'units', 8, '12-in-1 USB-C dock', 0, 1)).lastInsertRowid;
    const sleeve = (await run(insP, 'Laptop Sleeve', 'SLV-15', acc, 'one_time', 39, 12, 'units', 8, 'Padded 15" sleeve', 0, 1)).lastInsertRowid;
    const install = (await run(insP, 'Installation & Setup', 'SVC-INST', svc, 'one_time', 299, 180, 'visit', 10, 'Onsite installation and configuration', 0, 0)).lastInsertRowid;
    const training = (await run(insP, 'Onsite Training Day', 'SVC-TRN', svc, 'one_time', 549, 360, 'day', 10, 'Full-day hands-on team training', 0, 0)).lastInsertRowid;
    const warranty = (await run(insP, 'Extended Warranty 3yr', 'SVC-WAR3', svc, 'one_time', 219, 90, 'units', 10, '3-year next-business-day warranty', 0, 0)).lastInsertRowid;
    const backup = (await run(insP, 'Cloud Backup Pro', 'SUB-BKP', sub, 'subscription', 0, 6, 'users', 5, 'Automated cloud backup, per user', 1, 0)).lastInsertRowid;
    const support = (await run(insP, 'Premium Support Plan', 'SUB-SUP', sub, 'subscription', 0, 700, 'units', 5, '24/7 premium support, yearly', 0, 0)).lastInsertRowid;
    const security = (await run(insP, 'Security Suite', 'SUB-SEC', sub, 'subscription', 0, 120, 'units', 5, 'Managed endpoint security, quarterly', 1, 0)).lastInsertRowid;

    const insV = 'INSERT INTO product_variants(product_id,attribute,value,extra_price) VALUES(?,?,?,?)';
    await run(insV, laptop, 'Configuration', 'Standard (16GB/512GB)', 0);
    await run(insV, laptop, 'Configuration', 'Performance (32GB/1TB)', 250);
    await run(insV, laptop, 'Configuration', 'Max (32GB/2TB + dGPU)', 430);
    await run(insV, mouse, 'Pack', 'Single', 0);
    await run(insV, mouse, 'Pack', '3-Pack', 110);

    /* --- price lists --- */
    await run('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)', 'Gold Partner Program', 'gold', 'USD', 'discount', 5);
    await run('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)', 'Silver Partner Pricing', 'silver', 'USD', 'discount', 2);
    await run('INSERT INTO price_lists(name,customer_tier,currency,rule_type,value) VALUES(?,?,?,?,?)', 'India List (INR)', 'bronze', 'INR', 'markup', 4);

    /* --- discount tiers & approval chain --- */
    await run('INSERT INTO discount_tiers(customer_tier,max_discount_pct) VALUES(?,?)', 'bronze', 5);
    await run('INSERT INTO discount_tiers(customer_tier,max_discount_pct) VALUES(?,?)', 'silver', 10);
    await run('INSERT INTO discount_tiers(customer_tier,max_discount_pct) VALUES(?,?)', 'gold', 15);
    await run('INSERT INTO approval_rules(name,level,risk_min,risk_max,any_line_over,sequence) VALUES(?,?,?,?,?,?)', 'Sales Manager review', 'manager', 0.5, 5, null, 1);
    await run('INSERT INTO approval_rules(name,level,risk_min,risk_max,any_line_over,sequence) VALUES(?,?,?,?,?,?)', 'Manager + Finance review', 'finance', 5.01, 999, 20, 2);

    /* --- warehouses + stock --- */
    const main = (await run('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)', 'Main Warehouse', 'WH-MAIN', 1.0, 'Denver, CO')).lastInsertRowid;
    const east = (await run('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)', 'East Depot', 'WH-EAST', 1.4, 'Newark, NJ')).lastInsertRowid;
    const west = (await run('INSERT INTO warehouses(name,code,shipping_cost_weight,address) VALUES(?,?,?,?)', 'West Hub', 'WH-WEST', 1.2, 'Oakland, CA')).lastInsertRowid;
    const insS = 'INSERT INTO stock_levels(warehouse_id,product_id,qty,reorder_point,replenishment_qty) VALUES(?,?,?,?,?)';
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
    for (const [pid, rows] of stockMap) for (const [wid, q, rp, rq] of rows) await run(insS, wid, pid, q, rp, rq);

    /* --- subscription plans --- */
    const monthly = (await run('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)', 'Monthly Essentials', 'monthly', 'daily', 'refund_prorated', 0, 0)).lastInsertRowid;
    const quarterly = (await run('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)', 'Quarterly Value', 'quarterly', 'daily', 'refund_pct', 70, 7)).lastInsertRowid;
    const yearly = (await run('INSERT INTO subscription_plans(name,billing_period,proration_rule,cancellation_policy,refund_pct,notice_days) VALUES(?,?,?,?,?,?)', 'Annual Advantage', 'yearly', 'daily', 'refund_pct', 70, 30)).lastInsertRowid;
    await run('INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)', backup, monthly, 29);
    await run('INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)', support, yearly, 1999);
    await run('INSERT INTO product_plans(product_id,plan_id,recurring_price) VALUES(?,?,?)', security, quarterly, 399);

    /* --- upsell rules (co-purchase history) --- */
    const insU = 'INSERT INTO upsell_rules(trigger_product_id,suggested_product_id,co_score,source) VALUES(?,?,?,?)';
    const upsell = [
      [laptop, mouse, 0.92, 'history'], [laptop, kbd, 0.86, 'history'], [laptop, monitor, 0.81, 'history'],
      [laptop, backup, 0.74, 'history'], [laptop, dock, 0.70, 'history'],
      [ultra, dock, 0.90, 'history'], [ultra, backup, 0.85, 'history'], [ultra, monitor, 0.80, 'history'],
      [router, security, 0.93, 'history'], [router, install, 0.64, 'history'],
      [install, training, 0.82, 'history'], [install, warranty, 0.78, 'history'],
      [monitor, dock, 0.75, 'history'], [mouse, kbd, 0.65, 'history'],
      [backup, security, 0.72, 'history'], [laptop, sleeve, 0.58, 'history'],
    ];
    for (const [t, s, sc, src] of upsell) await run(insU, t, s, sc, src);

    /* --- commission rules --- */
    const tiered = JSON.stringify([{ min_margin: 40, rate: 6 }, { min_margin: 30, rate: 4.5 }, { min_margin: 20, rate: 3 }, { min_margin: 0, rate: 1.5 }]);
    await run(`INSERT INTO commission_rules(name,scope,rate_type,rate,margin_tiers) VALUES(?,?,?,?,?)`, 'Standard Commission — margin tiered', 'all', 'margin_tier', 3, tiered);
    await run(`INSERT INTO commission_rules(name,scope,team,rate_type,rate) VALUES(?,?,?,?,?)`, 'Enterprise Team Bonus', 'team', 'Enterprise', 'percentage', 4.5);
    await run(`INSERT INTO commission_rules(name,scope,salesperson_id,rate_type,rate) VALUES(?,?,?,?,?)`, 'Asha Verma — Star Rep Plan', 'salesperson', uAsha, 'percentage', 5);
    await run(`INSERT INTO commission_rules(name,scope,category_id,rate_type,rate) VALUES(?,?,?,?,?)`, 'Subscriptions Attach Bonus', 'category', sub, 'percentage', 8);
    await run(`INSERT INTO commission_rules(name,scope,product_id,rate_type,rate) VALUES(?,?,?,?,?)`, 'Premium Support Push Bonus', 'product', support, 'fixed', 75);

    /* --- settings --- */
    await setSetting('stalled_days', 3, c);
    await setSetting('anomaly_multiplier', 1.5, c);
    await setSetting('slippage_days', 2, c);
    await setSetting('usd_inr', 83, c);
    await setSetting('min_margin_pct', 30, c);
    await setSetting('base_ship_cost', 18, c);
    await setSetting('company_name', 'DealFlow360 Inc.', c);

    /* --- seed quotations for a "lived-in" demo --- */
    const now = Date.now();
    const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
    const daysAhead = (d) => new Date(now + d * 86400000).toISOString();
    const insQ = `INSERT INTO quotations(number,customer_id,rep_id,status,currency,exchange_rate,order_discount_pct,subtotal,discount_total,tax_total,total,cost_total,margin_pct,risk_score,max_violation,approval_level,valid_until,expected_delivery,portal_token,created_at,last_activity_at,submitted_at,sent_at,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const insL = `INSERT INTO quotation_lines(quotation_id,product_id,variant_id,description,qty,unit_price,cost_price,discount_pct,line_type,plan_id,billing_period,sort)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;
    const token = () => crypto.randomBytes(12).toString('hex');

    // QT-1018: OLD draft -> stalled alert (Beta, Vikram)
    let qid = (await run(insQ, 'QT-1018', beta, uVikram, 'draft', 'USD', 1, 0, 549, 0, 54.9, 603.9, 360, 40.4, 0, 0, 'none', daysAhead(21), daysAhead(30), token(), daysAgo(12), daysAgo(12), null, null, null)).lastInsertRowid;
    await run(insL, qid, training, null, 'Onsite Training Day', 1, 549, 360, 0, 'one_time', null, null, 0);

    // QT-1010: confirmed with unusually high discount -> anomaly alert (Acme, Asha)
    qid = (await run(insQ, 'QT-1010', acme, uAsha, 'confirmed', 'USD', 1, 0, 4387, 695.5, 369.2, 4060.7, 3162, 22.1, 4.8, 4.8, 'manager', daysAgo(25), daysAgo(10), token(), daysAgo(26), daysAgo(20), daysAgo(24), null, daysAgo(24))).lastInsertRowid;
    await run(insL, qid, monitor, null, '27" 4K Monitor', 4, 449, 290, 22, 'one_time', null, null, 0);
    await run(insL, qid, mouse, null, 'Wireless Mouse', 6, 59, 22, 18, 'one_time', null, null, 1);
    await run(insL, qid, laptop, null, 'Laptop Pro 15"', 2, 1299, 940, 12, 'one_time', null, null, 2);

    // QT-1025: confirmed, delivery slipped (Gamma, Asha) -> slippage alert + open invoice for payment demo
    qid = (await run(insQ, 'QT-1025', gamma, uAsha, 'confirmed', 'INR', 83, 0, 26790, 0, 1339.5, 28129.5, 11880, 55.8, 0, 0, 'none', daysAgo(6), daysAgo(5), token(), daysAgo(8), daysAgo(4), daysAgo(8), null, daysAgo(7))).lastInsertRowid;
    await run(insL, qid, sleeve, null, 'Laptop Sleeve', 30, 39 * 4.32, 12 * 4.32, 0, 'one_time', null, null, 0); // INR approx
    await run(insL, qid, dock, null, 'USB-C Docking Station', 5, 249 * 4.32, 140 * 4.32, 0, 'one_time', null, null, 1);

    // QT-1032: sent to portal (Delta, Asha) -> negotiation demo
    qid = (await run(insQ, 'QT-1032', delta, uAsha, 'sent', 'USD', 1, 0, 1073, 0, 53.65, 1126.65, 852.8, 20.4, 0, 0, 'none', daysAhead(15), daysAhead(7), token(), daysAgo(4), daysAgo(1), null, daysAgo(2), null)).lastInsertRowid;
    await run(insL, qid, backup, null, 'Cloud Backup Pro (per user/mo)', 25, 29, 6, 10, 'subscription', monthly, 'monthly', 0);
    await run(insL, qid, laptop, null, 'Laptop Pro 15"', 1, 1299, 940, 5, 'one_time', null, null, 1);

    // QT-1039: confirmed & fulfilled with paid invoices (Gamma, Vikram) -> reporting baseline
    // totals computed from the same line values below (0% discount): mouse/kbd 8% tax, security 5%
    const rr2 = (x) => Math.round(x * 100) / 100;
    const rr1 = (x) => Math.round(x * 10) / 10;
    const l1039Defs = [
      [mouse, 'Wireless Mouse (3-Pack)', 5, (59 + 110) * 4.32, 66 * 4.32, 8, 'one_time', null, null, 0],
      [kbd, 'Mechanical Keyboard', 10, 129 * 4.32, 58 * 4.32, 8, 'one_time', null, null, 1],
      [security, 'Security Suite (per qtr)', 4, 399 * 4.32, 120 * 4.32, 5, 'subscription', quarterly, 'quarterly', 2],
    ];
    let sub1039 = 0, tax1039 = 0, cost1039 = 0;
    for (const [, , qty, price, cost, taxRate] of l1039Defs) {
      sub1039 += qty * price; tax1039 += qty * price * taxRate / 100; cost1039 += qty * cost;
    }
    const tot1039 = sub1039 + tax1039;
    const margin1039 = (tot1039 - cost1039) / tot1039 * 100;
    qid = (await run(insQ, 'QT-1039', gamma, uVikram, 'fulfilled', 'INR', 83, 0,
      rr2(sub1039), 0, rr2(tax1039), rr2(tot1039), rr2(cost1039), rr1(margin1039), 0, 0, 'none',
      daysAgo(3), daysAgo(2), token(), daysAgo(18), daysAgo(12), daysAgo(18), null, daysAgo(17))).lastInsertRowid;
    for (const [pid, desc, qty, price, cost, , type, plan, period, sort] of l1039Defs) {
      await run(insL, qid, pid, null, desc, qty, price, cost, 0, type, plan, period, sort);
    }

    // more historical confirmed quotes (baseline for anomaly stats)
    const hist = [
      ['QT-1004', acme, uAsha, 6, 0, 'fulfilled'],
      ['QT-1007', beta, uVikram, 11, 3, 'fulfilled'],
      ['QT-1012', acme, uAsha, 8, 2, 'fulfilled'],
      ['QT-1015', delta, uAsha, 5, 1, 'fulfilled'],
    ];
    for (const [num, cust, rep, dAgo, disc] of hist) {
      const sub = 2500 + Math.round(Math.random() * 1800);
      const discTotal = sub * disc / 100;
      const tax = (sub - discTotal) * 0.08;
      const cost = (sub - discTotal) * 0.62;
      const tot = sub - discTotal + tax;
      qid = (await run(insQ, num, cust, rep, 'fulfilled', 'USD', 1, 0, sub, discTotal, tax, tot, cost, ((tot - cost) / tot * 100), 0, 0, 'none', daysAgo(dAgo - 5), daysAgo(dAgo + 2), token(), daysAgo(dAgo + 1), daysAgo(dAgo), daysAgo(dAgo), null, daysAgo(dAgo))).lastInsertRowid;
      await run(insL, qid, laptop, null, 'Laptop Pro 15"', 1, 1299, 940, disc, 'one_time', null, null, 0);
      await run(insL, qid, mouse, null, 'Wireless Mouse', 2, 59, 22, disc, 'one_time', null, null, 1);
    }

    // QT-1041: pending manager approval (Beta, Asha)
    qid = (await run(insQ, 'QT-1041', beta, uAsha, 'pending_manager', 'USD', 1, 0, 3292, 63, 258.3, 3487.3, 2260, 35.2, 4, 4, 'manager', daysAhead(10), daysAhead(6), token(), daysAgo(2), daysAgo(1), daysAgo(1), null, null)).lastInsertRowid;
    await run(insL, qid, monitor, null, '27" 4K Monitor', 6, 449, 290, 14, 'one_time', null, null, 0);
    await run(insL, qid, router, null, 'Wi-Fi 6 Router', 2, 199, 105, 8, 'one_time', null, null, 1);
    await run('INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,?,?)', qid, 'manager', 1, 'pending');
    await run('INSERT INTO audit_log(entity,entity_id,user_id,user_name,action,details) VALUES(?,?,?,?,?,?)', 'quotation', qid, 1, 'Asha Verma', 'submitted_for_approval', 'Auto-routed to Sales Manager (blended risk 4.0)');

    /* --- invoices + payments for fulfilled quotes --- */
    const insI = 'INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
    const insPay = 'INSERT INTO payments(invoice_id,amount,method,reference,paid_at) VALUES(?,?,?,?,?)';
    const insFS = 'INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost,shipped_at) VALUES(?,?,?,?,?,?,?)';
    const insBS = 'INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id) VALUES(?,?,?,?,?,?,?)';

    // QT-1039 (Gamma): one-time invoice paid, recurring schedule + first paid
    const q1039 = await one('SELECT id FROM quotations WHERE number=?', 'QT-1039');
    const l1039 = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [q1039.id], c);
    const oneTimeAmount = l1039.filter((l) => l.line_type === 'one_time').reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100), 0);
    const inv1 = (await run(insI, 'INV-2031', q1039.id, gamma, 'one_time', Math.round(oneTimeAmount * 1.05), 'paid', daysAgo(16), daysAgo(15), daysAgo(17))).lastInsertRowid;
    await run(insPay, inv1, Math.round(oneTimeAmount * 1.05), 'bank_transfer', 'TXN-88121', daysAgo(15));
    const secLine = l1039.find((l) => l.line_type === 'subscription');
    if (secLine) {
      const inv2 = (await run(insI, 'INV-2032', q1039.id, gamma, 'recurring', Math.round(secLine.qty * secLine.unit_price * 1.05), 'paid', daysAgo(16), daysAgo(15), daysAgo(17))).lastInsertRowid;
      await run(insPay, inv2, Math.round(secLine.qty * secLine.unit_price * 1.05), 'bank_transfer', 'TXN-88122', daysAgo(15));
      for (let i = 1; i <= 4; i++) {
        const d = new Date(now + i * 90 * 86400000).toISOString().slice(0, 10);
        await run(insBS, q1039.id, secLine.id, d, `Security Suite — cycle ${i + 1} (4 units)`, secLine.qty * secLine.unit_price, 'scheduled', null);
      }
    }
    for (const l of l1039.filter((l) => l.line_type === 'one_time')) {
      await run(insFS, q1039.id, l.id, main, l.qty, 'shipped', 18, daysAgo(12));
    }

    // QT-1025 (Gamma slippage): open invoice -> payment demo target
    const q1025 = await one('SELECT id FROM quotations WHERE number=?', 'QT-1025');
    const l1025 = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [q1025.id], c);
    const amt1025 = Math.round(l1025.reduce((s, l) => s + l.qty * l.unit_price, 0) * 1.05);
    await run(insI, 'INV-2044', q1025.id, gamma, 'one_time', amt1025, 'open', daysAhead(9), null, daysAgo(6));
    for (const l of l1025) await run(insFS, q1025.id, l.id, main, Math.ceil(l.qty / 2), 'shipped', 18, daysAgo(4));
    await run(insFS, q1025.id, l1025[1].id, main, l1025[1].qty - Math.ceil(l1025[1].qty / 2), 'backorder', 0, null);

    // QT-1010 paid invoice
    const q1010 = await one('SELECT id FROM quotations WHERE number=?', 'QT-1010');
    const inv1010 = (await run(insI, 'INV-2018', q1010.id, acme, 'one_time', 4060.7, 'paid', daysAgo(23), daysAgo(22), daysAgo(24))).lastInsertRowid;
    await run(insPay, inv1010, 4060.7, 'card', 'TXN-87901', daysAgo(22));

    // QT-1004/1007/1012/1015 paid invoices (baseline reporting)
    const paidHist = [['QT-1004', acme], ['QT-1007', beta], ['QT-1012', acme], ['QT-1015', delta]];
    let invNo = 2010;
    for (const [num, cust] of paidHist) {
      const qq = await one('SELECT id, total FROM quotations WHERE number=?', num);
      const inv = (await run(insI, `INV-${invNo++}`, qq.id, cust, 'one_time', Math.round(qq.total), 'paid', null, null, daysAgo(5))).lastInsertRowid;
      await run(insPay, inv, Math.round(qq.total), 'bank_transfer', `TXN-${88000 + invNo}`, daysAgo(4));
    }

    /* --- seed commissions for every paid invoice (lived-in commission history) --- */
    const tierRules = [
      { id: 1, name: 'Standard Commission — margin tiered', rate_type: 'margin_tier', rate: 3, tiers: [{ min_margin: 40, rate: 6 }, { min_margin: 30, rate: 4.5 }, { min_margin: 20, rate: 3 }, { min_margin: 0, rate: 1.5 }] },
    ];
    let comNo = 1;
    const paidInvoices = await Q(`SELECT i.id, i.amount, i.paid_at, q.id quotation_id, q.margin_pct, q.rep_id
      FROM invoices i JOIN quotations q ON q.id=i.quotation_id WHERE i.status='paid' ORDER BY i.id`, [], c);
    for (const inv of paidInvoices) {
      const rule = tierRules[0];
      const tier = rule.tiers.find((t) => inv.margin_pct >= t.min_margin) || rule.tiers[rule.tiers.length - 1];
      const amount = Math.round(inv.amount * tier.rate / 100 * 100) / 100;
      const period = (inv.paid_at || new Date().toISOString()).slice(0, 7);
      await run(`INSERT INTO commissions(number,quotation_id,invoice_id,salesperson_id,base_amount,margin_pct,rule_id,rule_name,rate,rate_type,amount,status,period,created_at,confirmed_at,approved_at,paid_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `COM-${String(comNo++).padStart(4, '0')}`, inv.quotation_id, inv.id, inv.rep_id,
        inv.amount, Math.round(inv.margin_pct * 10) / 10, rule.id, rule.name, tier.rate, 'margin_tier', amount, 'paid', period,
        inv.paid_at, inv.paid_at, inv.paid_at, inv.paid_at);
    }
  });
}

/* ---------- init ---------- */
async function init() {
  if (process.env.DF_RESET) {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('  [db] schema dropped (DF_RESET)');
  }
  await pool.query(SCHEMA);
  await seed();
}

module.exports = { pool, Q, ONE, RUN, TX, NOW_ISO, TODAY, getSetting, setSetting, hashPassword, verifyPassword, init };
