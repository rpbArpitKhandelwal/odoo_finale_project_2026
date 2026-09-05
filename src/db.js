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
`;


db.exec(SCHEMA);

module.exports = { db, hashPassword, verifyPassword, getSetting, setSetting };
