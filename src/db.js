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


db.exec(SCHEMA);

module.exports = { db, hashPassword, verifyPassword, getSetting, setSetting };
