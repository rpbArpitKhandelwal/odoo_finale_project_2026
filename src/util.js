/* DealFlow360 — auth/session middleware & helpers (PostgreSQL, async) */
'use strict';
const crypto = require('crypto');
const { Q, ONE, RUN } = require('./db');

const COOKIE = 'df_session';
const PORTAL_COOKIE = 'df_portal';

function parseCookies(req) {
  const out = {}; const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/* COOKIE_SECURE=1 (set on HTTPS hosts) adds the Secure flag; local http keeps working without it */
const SECURE = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
function setCookie(res, name, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE}`);
}
function clearCookie(res, name) { setCookie(res, name, '', 0); }

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await RUN('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', [token, userId, expires]);
  return token;
}
async function destroySession(token) { if (token) await RUN('DELETE FROM sessions WHERE token=?', [token]); }

async function userForToken(token) {
  if (!token) return null;
  const s = await ONE('SELECT * FROM sessions WHERE token=?', [token]);
  if (!s || s.expires_at < new Date().toISOString()) return null;
  const u = await ONE('SELECT u.*, c.name customer_name, c.tier customer_tier FROM users u LEFT JOIN customers c ON c.id=u.customer_id WHERE u.id=? AND u.active', [s.user_id]);
  return u || null;
}

/* req.user attached for internal users (any role) */
async function requireAuth(req, res, next) {
  try {
    const u = await userForToken(parseCookies(req)[COOKIE]);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    req.user = u; next();
  } catch (e) { next(e); }
}
/* internal (non-customer) users only */
async function requireInternal(req, res, next) {
  try {
    const u = await userForToken(parseCookies(req)[COOKIE]);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    if (u.role === 'customer') return res.status(403).json({ error: 'Internal access only' });
    req.user = u; next();
  } catch (e) { next(e); }
}
function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const u = await userForToken(parseCookies(req)[COOKIE]);
      if (!u) return res.status(401).json({ error: 'Not signed in' });
      if (!roles.includes(u.role)) return res.status(403).json({ error: `Requires role: ${roles.join(' / ')}` });
      req.user = u; next();
    } catch (e) { next(e); }
  };
}
/* portal customer session OR quotation magic token */
async function requirePortal(req, res, next) {
  try {
    const u = await userForToken(parseCookies(req)[PORTAL_COOKIE]);
    if (u && u.role === 'customer') { req.user = u; req.via = 'login'; return next(); }
    const key = req.query.k || req.headers['x-portal-key'];
    if (key) {
      const q = await ONE('SELECT * FROM quotations WHERE portal_token=?', [String(key)]);
      if (q) { req.user = null; req.quote = q; req.via = 'magic'; return next(); }
    }
    return res.status(401).json({ error: 'Portal sign-in required' });
  } catch (e) { next(e); }
}

module.exports = { COOKIE, PORTAL_COOKIE, parseCookies, setCookie, clearCookie, createSession, destroySession, userForToken, requireAuth, requireInternal, requireRole, requirePortal };
