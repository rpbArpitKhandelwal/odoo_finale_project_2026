/* DealFlow360 — Database layer (PostgreSQL via node-postgres) */
'use strict';
const { Pool } = require('pg');
const crypto = require('crypto');

/* ---------- connection ----------
 * Hosted platforms (Render, Railway, Neon, Supabase, Heroku…) hand out a single DATABASE_URL and require TLS;
 * local development uses the PG* variables (or the defaults below) without TLS. PGSSL=1/0 forces either way. */
const DATABASE_URL = process.env.DATABASE_URL || '';
const wantSsl = process.env.PGSSL != null
  ? process.env.PGSSL === '1'
  : !!DATABASE_URL && !/localhost|127\.0\.0\.1|@db[:/]/.test(DATABASE_URL);
const pool = new Pool(DATABASE_URL
  ? { connectionString: DATABASE_URL, ssl: wantSsl ? { rejectUnauthorized: false } : false, max: 10 }
  : {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'dealflow',
    password: process.env.PGPASSWORD || 'DealFlow@2026',
    database: process.env.PGDATABASE || 'dealflow360',
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
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
  active BOOLEAN DEFAULT true,
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
  promoted BOOLEAN DEFAULT false,
  stocked BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true
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
  active BOOLEAN DEFAULT true
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
  active BOOLEAN DEFAULT true
);
CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  shipping_cost_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  address TEXT DEFAULT '',
  active BOOLEAN DEFAULT true
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
  active BOOLEAN DEFAULT true
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
  active BOOLEAN DEFAULT true,
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
  submitted_at TEXT, sent_at TEXT, confirmed_at TEXT, customer_confirmed_at TEXT,
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
  dismissed BOOLEAN DEFAULT false
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
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','declined','info')),
  created_at TEXT DEFAULT (${NOW_ISO}),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('stalled','anomaly','slippage','backorder')),
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
  active BOOLEAN DEFAULT true,
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

/* ---------- volume history generator (deterministic LCG → identical data on every reset) ---------- */
function makeRng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const TIER_CEILING = { bronze: 5, silver: 10, gold: 15 };
const CAT_CEILING = { hw: 15, svc: 10, sub: 12, acc: 20 };
/* ~260 quotations over the last 8 months. Statuses are chosen so the curated demo story is untouched:
 * no planned splits (nothing reserved), open quotes are recent (no flood of stalled alerts), no slipping deliveries. */
async function seedVolume(run, ctx) {
  const { customers, reps, products, daysAgo, daysAhead, insQ, insL, token } = ctx;
  const rnd = makeRng(20260905);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const r2 = (x) => Math.round(x * 100) / 100;
  const unitPrice = (p, cust) => {
    if (p.type === 'subscription') return p.recurring;
    if (cust.currency === 'INR') return r2(p.base * 1.04);            // India List (INR): +4% markup
    return r2(p.base * (1 - ({ gold: 5, silver: 2, bronze: 0 })[cust.tier] / 100)); // partner pricelists
  };
  const out = [];
  for (let i = 0; i < 260; i++) {
    const cust = pick(customers), rep = pick(reps);
    const roll = rnd();
    const status = roll < 0.74 ? 'fulfilled' : roll < 0.79 ? 'approved' : roll < 0.85 ? 'sent' : roll < 0.91 ? 'pending_manager' : roll < 0.96 ? 'rejected' : 'draft';
    const isOpen = ['approved', 'sent', 'pending_manager', 'draft'].includes(status);
    const age = isOpen ? between(0, 9) : between(4, 240);            // days since creation
    const created = daysAgo(age);
    const activity = daysAgo(isOpen ? Math.min(age, between(0, 2)) : Math.max(0, age - between(1, 3)));
    const confirmed = status === 'fulfilled' ? daysAgo(Math.max(0, age - between(1, 3))) : null;
    const submitted = ['draft'].includes(status) ? null : daysAgo(Math.max(0, age - 1));
    const sent = status === 'sent' ? daysAgo(Math.max(0, age - 1)) : null;
    const delivery = status === 'fulfilled' ? daysAgo(Math.max(0, age - between(4, 9))) : daysAhead(between(5, 20));
    const number = `QT-0${700 + i}`;
    const qid = (await run(insQ, number, cust.id, rep, status, cust.currency, cust.currency === 'INR' ? 83 : 1, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 'none', daysAhead(between(5, 30)), delivery, token(), created, activity, submitted, sent, confirmed)).lastInsertRowid;
    const nLines = between(1, 4);
    const chosen = new Set();
    for (let k = 0; k < nLines; k++) {
      const p = pick(products);
      if (chosen.has(p.id)) continue;
      chosen.add(p.id);
      const allowed = Math.min(TIER_CEILING[cust.tier], CAT_CEILING[p.cat]);
      // realistic discounting: most lines at 0–3%, a tail up to the ceiling, ~6% of lines over the ceiling (approval history)
      const disc = rnd() < 0.94 ? Math.floor(Math.pow(rnd(), 2.5) * (allowed + 1)) : between(allowed + 1, allowed + 6);
      const qty = p.type === 'subscription' ? (p.per === 'users' ? between(5, 40) : between(1, 4)) : p.cat === 'svc' ? between(1, 3) : between(1, 12);
      const desc = p.type === 'subscription' ? `${p.name} (${p.period})` : p.name;
      await run(insL, qid, p.id, null, desc, qty, unitPrice(p, cust), p.cost, disc, p.type === 'subscription' ? 'subscription' : 'one_time', p.plan || null, p.period || null, k);
    }
    out.push({ id: qid, number, status, customer_id: cust.id, currency: cust.currency, age, confirmed });
  }
  return out;
}

/* ---------- seed ---------- */
async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int c FROM users');
  if (rows[0].c > 0) return; // already seeded

  const ids = await TX(async (c) => {
    const run = (sql, ...p) => RUN(sql, p, c);
    const one = (sql, ...p) => ONE(sql, p, c);

    /* --- users --- */
    const uAsha = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Gangadhar', 'rep@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'Enterprise')).lastInsertRowid;
    const uVikram = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Vikram Singh', 'rep2@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'SMB')).lastInsertRowid;
    const uNeha = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Neha Iyer', 'rep3@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'SMB')).lastInsertRowid;
    const uKaran = (await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Karan Mehta', 'rep4@dealflow.io', hashPassword('Rep@123'), 'salesrep', 'Enterprise')).lastInsertRowid;
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Achintya Rai', 'manager@dealflow.io', hashPassword('Manager@123'), 'manager', 'Enterprise');
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'Arpit Khandelwal', 'finance@dealflow.io', hashPassword('Finance@123'), 'finance', 'Finance');
    await run('INSERT INTO users(name,email,password,role,sales_team) VALUES(?,?,?,?,?)', 'System Admin', 'admin@dealflow.io', hashPassword('Admin@123'), 'admin', 'Direct');

    /* --- customers (+ portal users) --- */
    const acme = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Acme Corp', 'buyer@acmecorp.com', '+1 415 555 0101', 'gold', 'USD', '100 Market St, San Francisco, CA')).lastInsertRowid;
    const beta = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Beta Industries', 'buyer@betaind.com', '+1 312 555 0142', 'silver', 'USD', '22 Lakeshore Dr, Chicago, IL')).lastInsertRowid;
    const gamma = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Gamma Retail', 'buyer@gammaretail.in', '+91 98200 11223', 'bronze', 'INR', 'Andheri East, Mumbai, IN')).lastInsertRowid;
    const delta = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', 'Delta Logistics', 'buyer@deltalog.com', '+1 713 555 0177', 'gold', 'USD', '9 Harbor Blvd, Houston, TX')).lastInsertRowid;
    const extraCustomers = [];
    for (const [name, email, phone, tier, cur, addr] of [
      ['Epsilon Health', 'procurement@epsilonhealth.com', '+1 617 555 0199', 'gold', 'USD', '55 Beacon St, Boston, MA'],
      ['Zeta Manufacturing', 'buying@zetamfg.com', '+1 313 555 0140', 'silver', 'USD', '410 Piquette Ave, Detroit, MI'],
      ['Theta Foods', 'orders@thetafoods.com', '+1 404 555 0166', 'bronze', 'USD', '12 Peachtree St, Atlanta, GA'],
      ['Kappa Textiles', 'purchase@kappatextiles.in', '+91 80410 22334', 'bronze', 'INR', 'Peenya, Bengaluru, IN'],
      ['Lambda Studios', 'it@lambdastudios.com', '+1 310 555 0122', 'silver', 'USD', '900 Sunset Blvd, Los Angeles, CA'],
      ['Omega Freight', 'ops@omegafreight.com', '+1 206 555 0188', 'gold', 'USD', '2200 Alaskan Way, Seattle, WA'],
    ]) {
      const cid = (await run('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)', name, email, phone, tier, cur, addr)).lastInsertRowid;
      extraCustomers.push({ id: cid, tier, currency: cur });
    }
    await run('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)', 'Tom Jacobs (Acme)', 'buyer@acmecorp.com', hashPassword('Customer@123'), 'customer', acme);
    await run('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)', 'Neha Kulkarni (Gamma)', 'buyer@gammaretail.in', hashPassword('Customer@123'), 'customer', gamma);
    await run('INSERT INTO users(name,email,password,role,customer_id) VALUES(?,?,?,?,?)', 'Maria Lopez (Delta)', 'buyer@deltalog.com', hashPassword('Customer@123'), 'customer', delta);

    /* --- categories --- */
    const hw = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Hardware', 15)).lastInsertRowid;
    const svc = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Services', 10)).lastInsertRowid;
    const sub = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Subscriptions', 12)).lastInsertRowid;
    const acc = (await run('INSERT INTO categories(name,discount_ceiling) VALUES(?,?)', 'Accessories', 20)).lastInsertRowid;

    /* --- products --- */
    const insP = 'INSERT INTO products(name,sku,category_id,product_type,base_price,cost_price,unit,tax_rate,description,promoted,stocked) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
    const laptop = (await run(insP, 'Laptop Pro 15"', 'LP-15', hw, 'one_time', 1299, 940, 'units', 8, '15" enterprise laptop, i7, 16GB, 512GB SSD', false, true)).lastInsertRowid;
    const ultra = (await run(insP, 'Laptop Ultra 14"', 'LU-14', hw, 'one_time', 1799, 1310, 'units', 8, '14" ultralight, i9, premium build', false, true)).lastInsertRowid;
    const monitor = (await run(insP, '27" 4K Monitor', 'MON-4K27', hw, 'one_time', 449, 290, 'units', 8, '27-inch 4K IPS display', true, true)).lastInsertRowid;
    const mouse = (await run(insP, 'Wireless Mouse', 'MOU-W1', hw, 'one_time', 59, 22, 'units', 8, 'Ergonomic wireless mouse', false, true)).lastInsertRowid;
    const kbd = (await run(insP, 'Mechanical Keyboard', 'KBD-M1', hw, 'one_time', 129, 58, 'units', 8, 'Backlit mechanical keyboard', false, true)).lastInsertRowid;
    const router = (await run(insP, 'Wi-Fi 6 Router', 'RTR-W6', hw, 'one_time', 199, 105, 'units', 8, 'Mesh-capable Wi-Fi 6 router', false, true)).lastInsertRowid;
    const dock = (await run(insP, 'USB-C Docking Station', 'DOCK-C1', acc, 'one_time', 249, 140, 'units', 8, '12-in-1 USB-C dock', false, true)).lastInsertRowid;
    const sleeve = (await run(insP, 'Laptop Sleeve', 'SLV-15', acc, 'one_time', 39, 12, 'units', 8, 'Padded 15" sleeve', false, true)).lastInsertRowid;
    const install = (await run(insP, 'Installation & Setup', 'SVC-INST', svc, 'one_time', 299, 180, 'visit', 10, 'Onsite installation and configuration', false, false)).lastInsertRowid;
    const training = (await run(insP, 'Onsite Training Day', 'SVC-TRN', svc, 'one_time', 549, 360, 'day', 10, 'Full-day hands-on team training', false, false)).lastInsertRowid;
    const warranty = (await run(insP, 'Extended Warranty 3yr', 'SVC-WAR3', svc, 'one_time', 219, 90, 'units', 10, '3-year next-business-day warranty', false, false)).lastInsertRowid;
    const backup = (await run(insP, 'Cloud Backup Pro', 'SUB-BKP', sub, 'subscription', 0, 6, 'users', 5, 'Automated cloud backup, per user', true, false)).lastInsertRowid;
    const support = (await run(insP, 'Premium Support Plan', 'SUB-SUP', sub, 'subscription', 0, 700, 'units', 5, '24/7 premium support, yearly', false, false)).lastInsertRowid;
    const security = (await run(insP, 'Security Suite', 'SUB-SEC', sub, 'subscription', 0, 120, 'units', 5, 'Managed endpoint security, quarterly', true, false)).lastInsertRowid;

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
      [dock, [[main, 0, 2, 10], [east, 0, 2, 10], [west, 0, 2, 10]]], // sold out everywhere → QT-1025's dock backorder waits for a restock / replenishment run
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
    await run(`INSERT INTO commission_rules(name,scope,salesperson_id,rate_type,rate) VALUES(?,?,?,?,?)`, 'Gangadhar — Star Rep Plan', 'salesperson', uAsha, 'percentage', 5);
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

    /* --- volume history first (lower ids), so the curated demo quotations stay at the top of every list --- */
    const volume = await seedVolume(run, {
      customers: [
        { id: acme, tier: 'gold', currency: 'USD' }, { id: beta, tier: 'silver', currency: 'USD' },
        { id: gamma, tier: 'bronze', currency: 'INR' }, { id: delta, tier: 'gold', currency: 'USD' }, ...extraCustomers,
      ],
      reps: [uAsha, uVikram, uNeha, uKaran, uAsha, uKaran], // enterprise reps carry a little more volume
      products: [
        { id: laptop, name: 'Laptop Pro 15"', base: 1299, cost: 940, cat: 'hw', type: 'one_time', stocked: true },
        { id: ultra, name: 'Laptop Ultra 14"', base: 1799, cost: 1310, cat: 'hw', type: 'one_time', stocked: true },
        { id: monitor, name: '27" 4K Monitor', base: 449, cost: 290, cat: 'hw', type: 'one_time', stocked: true },
        { id: mouse, name: 'Wireless Mouse', base: 59, cost: 22, cat: 'hw', type: 'one_time', stocked: true },
        { id: kbd, name: 'Mechanical Keyboard', base: 129, cost: 58, cat: 'hw', type: 'one_time', stocked: true },
        { id: router, name: 'Wi-Fi 6 Router', base: 199, cost: 105, cat: 'hw', type: 'one_time', stocked: true },
        { id: dock, name: 'USB-C Docking Station', base: 249, cost: 140, cat: 'acc', type: 'one_time', stocked: true },
        { id: sleeve, name: 'Laptop Sleeve', base: 39, cost: 12, cat: 'acc', type: 'one_time', stocked: true },
        { id: install, name: 'Installation & Setup', base: 299, cost: 180, cat: 'svc', type: 'one_time', stocked: false },
        { id: training, name: 'Onsite Training Day', base: 549, cost: 360, cat: 'svc', type: 'one_time', stocked: false },
        { id: warranty, name: 'Extended Warranty 3yr', base: 219, cost: 90, cat: 'svc', type: 'one_time', stocked: false },
        { id: backup, name: 'Cloud Backup Pro', recurring: 29, cost: 6, cat: 'sub', type: 'subscription', plan: monthly, period: 'monthly', per: 'users' },
        { id: support, name: 'Premium Support Plan', recurring: 1999, cost: 700, cat: 'sub', type: 'subscription', plan: yearly, period: 'yearly' },
        { id: security, name: 'Security Suite', recurring: 399, cost: 120, cat: 'sub', type: 'subscription', plan: quarterly, period: 'quarterly' },
      ],
      daysAgo, daysAhead, insQ, insL, token,
    });

    // QT-1018: OLD draft -> stalled alert (Beta, Vikram)
    let qid = (await run(insQ, 'QT-1018', beta, uVikram, 'draft', 'USD', 1, 0, 549, 0, 54.9, 603.9, 360, 40.4, 0, 0, 'none', daysAhead(21), daysAhead(30), token(), daysAgo(12), daysAgo(12), null, null, null)).lastInsertRowid;
    await run(insL, qid, training, null, 'Onsite Training Day', 1, 549, 360, 0, 'one_time', null, null, 0);

    // QT-1010: most recently confirmed Acme deal with an unusually high discount (≈16% vs Gangadhar's ~1% history) -> anomaly alert
    qid = (await run(insQ, 'QT-1010', acme, uAsha, 'confirmed', 'USD', 1, 0, 4387, 695.5, 369.2, 4060.7, 3162, 22.1, 8.5, 7, 'finance', daysAhead(5), daysAhead(4), token(), daysAgo(6), daysAgo(2), daysAgo(4), null, daysAgo(2))).lastInsertRowid;
    await run(insL, qid, monitor, null, '27" 4K Monitor', 4, 449, 290, 22, 'one_time', null, null, 0);
    await run(insL, qid, mouse, null, 'Wireless Mouse', 6, 59, 22, 18, 'one_time', null, null, 1);
    await run(insL, qid, laptop, null, 'Laptop Pro 15"', 2, 1299, 940, 12, 'one_time', null, null, 2);

    // QT-1025: confirmed, delivery slipped (Gamma, Gangadhar) -> slippage alert + open invoice for payment demo
    qid = (await run(insQ, 'QT-1025', gamma, uAsha, 'confirmed', 'INR', 83, 0, 26790, 0, 1339.5, 28129.5, 11880, 55.8, 0, 0, 'none', daysAgo(6), daysAgo(5), token(), daysAgo(8), daysAgo(4), daysAgo(8), null, daysAgo(7))).lastInsertRowid;
    await run(insL, qid, sleeve, null, 'Laptop Sleeve', 30, 39 * 4.32, 12 * 4.32, 0, 'one_time', null, null, 0); // INR approx
    await run(insL, qid, dock, null, 'USB-C Docking Station', 5, 249 * 4.32, 140 * 4.32, 0, 'one_time', null, null, 1);

    // QT-1032: sent to portal (Delta, Gangadhar) -> negotiation demo
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
    const histSubtotals = [3120, 2740, 3865, 2980]; // deterministic seed → identical demo numbers on every reset
    for (const [i, [num, cust, rep, dAgo, disc]] of hist.entries()) {
      const sub = histSubtotals[i];
      const discTotal = sub * disc / 100;
      const tax = (sub - discTotal) * 0.08;
      const cost = (sub - discTotal) * 0.62;
      const tot = sub - discTotal + tax;
      qid = (await run(insQ, num, cust, rep, 'fulfilled', 'USD', 1, 0, sub, discTotal, tax, tot, cost, ((tot - cost) / tot * 100), 0, 0, 'none', daysAgo(dAgo - 5), daysAgo(dAgo + 2), token(), daysAgo(dAgo + 1), daysAgo(dAgo), daysAgo(dAgo), null, daysAgo(dAgo))).lastInsertRowid;
      await run(insL, qid, laptop, null, 'Laptop Pro 15"', 1, 1299, 940, disc, 'one_time', null, null, 0);
      await run(insL, qid, mouse, null, 'Wireless Mouse', 2, 59, 22, disc, 'one_time', null, null, 1);
    }

    // QT-1041: pending manager approval (Beta, Gangadhar)
    qid = (await run(insQ, 'QT-1041', beta, uAsha, 'pending_manager', 'USD', 1, 0, 3292, 63, 258.3, 3487.3, 2260, 35.2, 4, 4, 'manager', daysAhead(10), daysAhead(6), token(), daysAgo(2), daysAgo(1), daysAgo(1), null, null)).lastInsertRowid;
    // silver ceiling is 10%: monitor 3 pts over, router 2 pts over → blended 3 + ½·2 = 4.0 → Sales Manager review
    await run(insL, qid, monitor, null, '27" 4K Monitor', 6, 449, 290, 13, 'one_time', null, null, 0);
    await run(insL, qid, router, null, 'Wi-Fi 6 Router', 2, 199, 105, 12, 'one_time', null, null, 1);
    await run('INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,?,?)', qid, 'manager', 1, 'pending');
    await run('INSERT INTO audit_log(entity,entity_id,user_id,user_name,action,details) VALUES(?,?,?,?,?,?)', 'quotation', qid, 1, 'Gangadhar', 'submitted_for_approval', 'Auto-routed to Sales Manager (blended risk 4.0)');

    return { acme, beta, gamma, delta, main, east, west, volume };
  });

  /* --- phase 2: derive every seeded quotation's totals / margin / risk / approval level from its lines with the SAME engine live quotes use --- */
  const E = require('./engines');
  const seededQuotes = await Q('SELECT id, status, last_activity_at FROM quotations');
  for (const q of seededQuotes) {
    const fresh = await E.recomputeTotals(q.id);
    const { level } = await E.requiredApprovalLevel(fresh);
    // a "pending approval" quotation whose lines turn out to be within limits is simply ready
    const status = q.status === 'pending_manager' && level === 'none' ? 'approved' : q.status;
    await RUN('UPDATE quotations SET approval_level=?, status=?, last_activity_at=? WHERE id=?', [level, status, q.last_activity_at, q.id]); // keep the seeded activity timeline (stalled alerts)
  }

  /* --- phase 3: invoices, payments, fulfillment, schedules and commissions on top of the consistent totals --- */
  await TX(async (c) => {
    const run = (sql, ...p) => RUN(sql, p, c);
    const one = (sql, ...p) => ONE(sql, p, c);
    const { acme, beta, gamma, delta, main, east, west, volume } = ids;
    const now = Date.now();
    const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
    const daysAhead = (d) => new Date(now + d * 86400000).toISOString();

    /* --- invoices + payments for fulfilled quotes --- */
    const insI = 'INSERT INTO invoices(number,quotation_id,customer_id,kind,amount,status,due_date,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
    const insPay = 'INSERT INTO payments(invoice_id,amount,method,reference,paid_at) VALUES(?,?,?,?,?)';
    const insFS = 'INSERT INTO fulfillment_splits(quotation_id,line_id,warehouse_id,qty,status,est_cost,shipped_at) VALUES(?,?,?,?,?,?,?)';
    const insBS = 'INSERT INTO billing_schedule(quotation_id,line_id,scheduled_date,description,amount,status,invoice_id) VALUES(?,?,?,?,?,?,?)';

    /* --- volume history: invoices, payments, shipments, subscription schedules, approval chains --- */
    const rndV = makeRng(777);
    const pickV = (a) => a[Math.floor(rndV() * a.length)];
    const monthsOf = (p) => (p === 'monthly' ? 1 : p === 'quarterly' ? 3 : 12);
    const addMonths = (iso, m) => { const d = new Date(iso); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
    let vInv = 1001, vTxn = 70001;
    for (const v of volume) {
      const lines = await Q(`SELECT l.*, p.tax_rate, p.stocked FROM quotation_lines l JOIN products p ON p.id=l.product_id WHERE l.quotation_id=? ORDER BY l.sort`, [v.id], c);
      if (v.status === 'pending_manager') {
        const q = await one('SELECT approval_level FROM quotations WHERE id=?', v.id);
        await run('INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,1,?)', v.id, 'manager', 'pending');
        if (q.approval_level === 'finance') await run('INSERT INTO approvals(quotation_id,level,sequence,status) VALUES(?,?,2,?)', v.id, 'finance', 'waiting');
        continue;
      }
      if (v.status !== 'fulfilled') continue;
      const confirmedAt = v.confirmed;
      const paidAt = new Date(new Date(confirmedAt).getTime() + (1 + Math.floor(rndV() * 6)) * 86400000).toISOString();
      const oneTime = lines.filter((l) => l.line_type === 'one_time');
      const oneTimeAmt = oneTime.reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + (l.tax_rate || 0) / 100), 0);
      if (oneTimeAmt > 0) {
        const inv = (await run(insI, `INV-${vInv++}`, v.id, v.customer_id, 'one_time', Math.round(oneTimeAmt * 100) / 100, 'paid', confirmedAt.slice(0, 10), paidAt, confirmedAt)).lastInsertRowid;
        await run(insPay, inv, Math.round(oneTimeAmt * 100) / 100, pickV(['bank_transfer', 'card', 'bank_transfer', 'upi']), `TXN-${vTxn++}`, paidAt);
      }
      for (const l of lines.filter((l) => l.line_type === 'subscription')) {
        const cycleAmt = Math.round(l.qty * l.unit_price * (1 - l.discount_pct / 100) * (1 + (l.tax_rate || 0) / 100) * 100) / 100;
        const inv = (await run(insI, `INV-${vInv++}`, v.id, v.customer_id, 'recurring', cycleAmt, 'paid', confirmedAt.slice(0, 10), paidAt, confirmedAt)).lastInsertRowid;
        await run(insPay, inv, cycleAmt, 'bank_transfer', `TXN-${vTxn++}`, paidAt);
        await run(insBS, v.id, l.id, confirmedAt.slice(0, 10), `${l.description} — cycle 1`, cycleAmt, 'invoiced', inv);
        const months = monthsOf(l.billing_period);
        const future = Math.max(1, Math.round(12 / months) - 1);
        for (let i = 1; i <= future; i++) await run(insBS, v.id, l.id, addMonths(confirmedAt, months * i), `${l.description} — cycle ${i + 1}`, cycleAmt, 'scheduled', null);
      }
      for (const l of oneTime.filter((l) => l.stocked)) {
        await run(insFS, v.id, l.id, pickV([main, main, east, west]), l.qty, 'shipped', 18, new Date(new Date(confirmedAt).getTime() + 2 * 86400000).toISOString());
      }
    }

    // QT-1039 (Gamma): one-time invoice paid, recurring schedule + first paid
    const q1039 = await one('SELECT id FROM quotations WHERE number=?', 'QT-1039');
    const l1039 = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [q1039.id], c);
    const oneTimeAmount = l1039.filter((l) => l.line_type === 'one_time').reduce((s, l) => s + l.qty * l.unit_price * (1 - l.discount_pct / 100), 0);
    const inv1 = (await run(insI, 'INV-2031', q1039.id, gamma, 'one_time', Math.round(oneTimeAmount * 1.08 * 100) / 100, 'paid', daysAgo(16), daysAgo(15), daysAgo(17))).lastInsertRowid;
    await run(insPay, inv1, Math.round(oneTimeAmount * 1.08 * 100) / 100, 'bank_transfer', 'TXN-88121', daysAgo(15));
    const secLine = l1039.find((l) => l.line_type === 'subscription');
    if (secLine) {
      const cycleAmt = Math.round(secLine.qty * secLine.unit_price * 1.05 * 100) / 100; // tax-inclusive, like live recurring invoices
      const inv2 = (await run(insI, 'INV-2032', q1039.id, gamma, 'recurring', cycleAmt, 'paid', daysAgo(16), daysAgo(15), daysAgo(17))).lastInsertRowid;
      await run(insPay, inv2, cycleAmt, 'bank_transfer', 'TXN-88122', daysAgo(15));
      // current quarterly cycle started 17 days ago (invoiced) → mid-cycle changes prorate over the remaining ~73/91 days
      await run(insBS, q1039.id, secLine.id, daysAgo(17).slice(0, 10), `${secLine.description} — cycle 1`, cycleAmt, 'invoiced', inv2);
      for (let i = 1; i <= 3; i++) {
        const d = new Date(new Date(daysAgo(17)).setMonth(new Date(daysAgo(17)).getMonth() + 3 * i)).toISOString().slice(0, 10);
        await run(insBS, q1039.id, secLine.id, d, `${secLine.description} — cycle ${i + 1}`, cycleAmt, 'scheduled', null);
      }
    }
    for (const l of l1039.filter((l) => l.line_type === 'one_time')) {
      await run(insFS, q1039.id, l.id, main, l.qty, 'shipped', 18, daysAgo(12));
    }

    // QT-1025 (Gamma slippage): open invoice -> payment demo target
    const q1025 = await one('SELECT id FROM quotations WHERE number=?', 'QT-1025');
    const l1025 = await Q('SELECT * FROM quotation_lines WHERE quotation_id=?', [q1025.id], c);
    const amt1025 = Math.round(l1025.reduce((s, l) => s + l.qty * l.unit_price, 0) * 1.08 * 100) / 100;
    await run(insI, 'INV-2044', q1025.id, gamma, 'one_time', amt1025, 'open', daysAhead(9), null, daysAgo(6));
    for (const l of l1025) await run(insFS, q1025.id, l.id, main, Math.ceil(l.qty / 2), 'shipped', 18, daysAgo(4));
    await run(insFS, q1025.id, l1025[1].id, main, l1025[1].qty - Math.ceil(l1025[1].qty / 2), 'backorder', 0, null);

    // QT-1010 paid invoice (amount = the engine-computed order total)
    const q1010 = await one('SELECT id, total FROM quotations WHERE number=?', 'QT-1010');
    const inv1010 = (await run(insI, 'INV-2018', q1010.id, acme, 'one_time', q1010.total, 'paid', daysAgo(1), daysAgo(1), daysAgo(2))).lastInsertRowid;
    await run(insPay, inv1010, q1010.total, 'card', 'TXN-87901', daysAgo(1));

    // QT-1004/1007/1012/1015 paid invoices (baseline reporting)
    const paidHist = [['QT-1004', acme], ['QT-1007', beta], ['QT-1012', acme], ['QT-1015', delta]];
    let invNo = 2010;
    for (const [num, cust] of paidHist) {
      const qq = await one('SELECT id, total FROM quotations WHERE number=?', num);
      const inv = (await run(insI, `INV-${invNo++}`, qq.id, cust, 'one_time', qq.total, 'paid', null, daysAgo(4), daysAgo(5))).lastInsertRowid;
      await run(insPay, inv, qq.total, 'bank_transfer', `TXN-${88000 + invNo}`, daysAgo(4));
    }

    /* --- seed commissions for every paid invoice (lived-in commission history) --- */
    const tierRules = [
      { id: 1, name: 'Standard Commission — margin tiered', rate_type: 'margin_tier', rate: 3, tiers: [{ min_margin: 40, rate: 6 }, { min_margin: 30, rate: 4.5 }, { min_margin: 20, rate: 3 }, { min_margin: 0, rate: 1.5 }] },
    ];
    let comNo = 1;
    const paidInvoices = await Q(`SELECT i.id, i.amount / q.exchange_rate amount, i.paid_at, q.id quotation_id, q.margin_pct, q.rep_id
      FROM invoices i JOIN quotations q ON q.id=i.quotation_id WHERE i.status='paid' ORDER BY i.id`, [], c); // commissions are paid in USD → INR invoices converted at the quote's rate
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

/* ---------- idempotent migrations for databases created by earlier versions ---------- */
const MIGRATIONS = `
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_confirmed_at TEXT;
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK(kind IN ('stalled','anomaly','slippage','backorder'));
ALTER TABLE negotiations DROP CONSTRAINT IF EXISTS negotiations_status_check;
ALTER TABLE negotiations ADD CONSTRAINT negotiations_status_check CHECK(status IN ('open','accepted','declined','info'));
CREATE INDEX IF NOT EXISTS idx_quotation_lines_q ON quotation_lines(quotation_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_q ON fulfillment_splits(quotation_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_wh_status ON fulfillment_splits(warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_rep ON quotations(rep_id);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_q ON invoices(quotation_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_inv ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_schedule_line ON billing_schedule(line_id, status);
CREATE INDEX IF NOT EXISTS idx_schedule_q ON billing_schedule(quotation_id);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON billing_schedule(status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_negotiations_q ON negotiations(quotation_id);
CREATE INDEX IF NOT EXISTS idx_alerts_q ON alerts(quotation_id);
CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_levels(product_id);
CREATE INDEX IF NOT EXISTS idx_commissions_rep ON commissions(salesperson_id, status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
`;

/* ---------- init ---------- */
async function init() {
  if (process.env.DF_RESET) {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('  [db] schema dropped (DF_RESET)');
  }
  await pool.query(SCHEMA);
  await pool.query(MIGRATIONS);
  await seed();
}

module.exports = { pool, Q, ONE, RUN, TX, NOW_ISO, TODAY, getSetting, setSetting, hashPassword, verifyPassword, init };
