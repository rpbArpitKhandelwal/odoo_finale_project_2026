/* DealFlow360 — auth + customer routes (PostgreSQL, async) */
'use strict';
const express = require('express');
const { Q, ONE, RUN, hashPassword, verifyPassword } = require('../db');
const { COOKIE, PORTAL_COOKIE, setCookie, clearCookie, createSession, destroySession, requireAuth, requireInternal, requireRole } = require('../util');
const { audit } = require('../engines');

const r = express.Router();

r.post('/auth/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a 6+ char password are required' });
  const exists = await ONE('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const info = await RUN('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)', [name, email.toLowerCase(), hashPassword(password), 'salesrep']);
  const user = await ONE('SELECT * FROM users WHERE id=?', [info.lastInsertRowid]);
  const token = await createSession(user.id);
  setCookie(res, COOKIE, token, 7 * 86400);
  await audit('user', user.id, user, 'signup', `New sales rep ${name} signed up`);
  res.json({ user: pubUser(user) });
});

r.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await ONE('SELECT * FROM users WHERE email=? AND active', [String(email || '').toLowerCase()]);
  if (!user || !verifyPassword(password || '', user.password)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = await createSession(user.id);
  setCookie(res, COOKIE, token, 7 * 86400);
  await audit('user', user.id, user, 'login', `${user.name} signed in`);
  res.json({ user: pubUser(user) });
});

r.post('/auth/logout', async (req, res) => {
  const { parseCookies, destroySession } = require('../util');
  await destroySession(parseCookies(req)[COOKIE]);
  clearCookie(res, COOKIE); clearCookie(res, PORTAL_COOKIE);
  res.json({ ok: true });
});

r.get('/auth/me', requireAuth, (req, res) => res.json({ user: pubUser(req.user) }));

/* portal (customer) login */
r.post('/auth/portal/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await ONE(`SELECT u.*, c.name customer_name FROM users u JOIN customers c ON c.id=u.customer_id
    WHERE u.email=? AND u.role='customer' AND u.active`, [String(email || '').toLowerCase()]);
  if (!user || !verifyPassword(password || '', user.password)) return res.status(401).json({ error: 'Invalid portal credentials' });
  const token = await createSession(user.id);
  setCookie(res, PORTAL_COOKIE, token, 7 * 86400);
  await audit('user', user.id, user, 'portal_login', `${user.name} signed in to the customer portal`);
  res.json({ user: { id: user.id, name: user.name, role: 'customer', customer_id: user.customer_id, customer_name: user.customer_name } });
});
/* portal session introspection + logout — the portal is its own auth surface (separate cookie) */
r.get('/auth/portal/me', async (req, res) => {
  const { parseCookies, userForToken } = require('../util');
  const u = await userForToken(parseCookies(req)[PORTAL_COOKIE]);
  if (!u || u.role !== 'customer') return res.status(401).json({ error: 'Portal sign-in required' });
  res.json({ user: { id: u.id, name: u.name, role: 'customer', customer_id: u.customer_id, customer_name: u.customer_name, customer_tier: u.customer_tier } });
});
r.post('/auth/portal/logout', async (req, res) => {
  const { parseCookies } = require('../util');
  await destroySession(parseCookies(req)[PORTAL_COOKIE]);
  clearCookie(res, PORTAL_COOKIE);
  res.json({ ok: true });
});

function pubUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, customer_id: u.customer_id, customer_name: u.customer_name, customer_tier: u.customer_tier, sales_team: u.sales_team };
}

/* ---- users admin ---- */
r.get('/users', requireRole('admin'), async (_req, res) => {
  res.json({ users: await Q(`SELECT id,name,email,role,sales_team,active,created_at FROM users ORDER BY id`) });
});
r.put('/users/:id', requireRole('admin'), async (req, res) => {
  const { role, active, sales_team } = req.body || {};
  await RUN('UPDATE users SET role=COALESCE(?,role), active=COALESCE(?,active), sales_team=COALESCE(?,sales_team) WHERE id=?',
    [role, active, sales_team, req.params.id]);
  await audit('user', Number(req.params.id), req.user, 'updated', `role=${role || 'unchanged'} active=${active ?? 'unchanged'}`);
  res.json({ ok: true });
});

/* ---- customers ---- */
r.get('/customers', requireInternal, async (_req, res) => {
  res.json({ customers: await Q('SELECT * FROM customers ORDER BY name') });
});
r.post('/customers', requireRole('admin', 'manager'), async (req, res) => {
  const { name, email, phone, tier, currency, address } = req.body || {};
  if (!name || !tier) return res.status(400).json({ error: 'Name and tier are required' });
  const info = await RUN('INSERT INTO customers(name,email,phone,tier,currency,address) VALUES(?,?,?,?,?,?)',
    [name, email || '', phone || '', tier, currency || 'USD', address || '']);
  await audit('customer', info.lastInsertRowid, req.user, 'created', `Customer ${name} (${tier})`);
  res.json({ customer: await ONE('SELECT * FROM customers WHERE id=?', [info.lastInsertRowid]) });
});
r.put('/customers/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { name, email, phone, tier, currency, address } = req.body || {};
  await RUN('UPDATE customers SET name=COALESCE(?,name),email=COALESCE(?,email),phone=COALESCE(?,phone),tier=COALESCE(?,tier),currency=COALESCE(?,currency),address=COALESCE(?,address) WHERE id=?',
    [name, email, phone, tier, currency, address, req.params.id]);
  await audit('customer', Number(req.params.id), req.user, 'updated', `Customer updated`);
  res.json({ ok: true });
});

module.exports = r;
