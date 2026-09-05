/* DealFlow360 — auth + customer routes */
'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword } = require('../db');
const { COOKIE, PORTAL_COOKIE, setCookie, clearCookie, createSession, destroySession, requireAuth, requireInternal, requireRole } = require('../util');
const { audit } = require('../engines');

const r = express.Router();

r.post('/auth/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a 6+ char password are required' });
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const info = db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run(name, email.toLowerCase(), hashPassword(password), 'salesrep');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
  const token = createSession(user.id);
  setCookie(res, COOKIE, token, 7 * 86400);
  audit('user', user.id, user, 'signup', `New sales rep ${name} signed up`);
  res.json({ user: pubUser(user) });
});

r.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email || '').toLowerCase());
  if (!user || !verifyPassword(password || '', user.password)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = createSession(user.id);
  setCookie(res, COOKIE, token, 7 * 86400);
  audit('user', user.id, user, 'login', `${user.name} signed in`);
  res.json({ user: pubUser(user) });
});

r.post('/auth/logout', (req, res) => {
  const { parseCookies, destroySession } = require('../util');
  destroySession(parseCookies(req)[COOKIE]);
  clearCookie(res, COOKIE); clearCookie(res, PORTAL_COOKIE);
  res.json({ ok: true });
});

r.get('/auth/me', requireAuth, (req, res) => res.json({ user: pubUser(req.user) }));

/* portal (customer) login */
r.post('/auth/portal/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare(`SELECT u.*, c.name customer_name FROM users u JOIN customers c ON c.id=u.customer_id
    WHERE u.email=? AND u.role='customer' AND u.active=1`).get(String(email || '').toLowerCase());
  if (!user || !verifyPassword(password || '', user.password)) return res.status(401).json({ error: 'Invalid portal credentials' });
  const token = createSession(user.id);
  setCookie(res, PORTAL_COOKIE, token, 7 * 86400);
  res.json({ user: { id: user.id, name: user.name, role: 'customer', customer_id: user.customer_id, customer_name: user.customer_name } });
});

function pubUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, customer_id: u.customer_id, customer_name: u.customer_name, customer_tier: u.customer_tier };
}

/* ---- users admin ---- */
r.get('/users', requireRole('admin'), (_req, res) => {
  res.json({ users: db.prepare(`SELECT id,name,email,role,active,created_at FROM users ORDER BY id`).all() });
});
r.put('/users/:id', requireRole('admin'), (req, res) => {
  const { role, active } = req.body || {};
  db.prepare('UPDATE users SET role=COALESCE(?,role), active=COALESCE(?,active) WHERE id=?').run(role, active, req.params.id);
  audit('user', Number(req.params.id), req.user, 'updated', `role=${role || 'unchanged'} active=${active ?? 'unchanged'}`);
  res.json({ ok: true });
});

/* ---- customers ---- */
r.get('/customers', requireInternal, (_req, res) => {
  res.json({ customers: db.prepare('SELECT * FROM customers ORDER BY name').all() });
});
r.post('/customers', requireRole('admin', 'manager'), (req, res) => {
  const { name, email, phone, tier, currency, address } = req.body || {};
  if (!name || !tier) return res.status(400).json({ error: 'Name and tier are required' });
  const info = db.prepare('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)')
    .run(name, email || '', phone || '', tier, currency || 'USD', address || '');
  audit('customer', Number(info.lastInsertRowid), req.user, 'created', `Customer ${name} (${tier})`);
  res.json({ customer: db.prepare('SELECT * FROM customers WHERE id=?').get(Number(info.lastInsertRowid)) });
});
r.put('/customers/:id', requireRole('admin', 'manager'), (req, res) => {
  const { name, email, phone, tier, currency, address } = req.body || {};
  db.prepare('UPDATE customers SET name=COALESCE(?,name),email=COALESCE(?,email),phone=COALESCE(?,phone),tier=COALESCE(?,tier),currency=COALESCE(?,currency),address=COALESCE(?,address) WHERE id=?')
    .run(name, email, phone, tier, currency, address, req.params.id);
  audit('customer', Number(req.params.id), req.user, 'updated', `Customer updated`);
  res.json({ ok: true });
});

module.exports = r;
