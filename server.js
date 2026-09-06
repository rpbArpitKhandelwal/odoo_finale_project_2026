/* DealFlow360 — server entrypoint (Node.js + Express + PostgreSQL + React client) */
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 4300;

const CLIENT_DIST = path.join(__dirname, 'client', 'dist');

app.set('trust proxy', 1); // behind Render / Railway / nginx: honour X-Forwarded-* for protocol + host
app.use(express.json({ limit: '2mb' }));

/* health check for hosting platforms and uptime monitors */
app.get('/api/health', async (_req, res) => {
  try {
    const r = await db.pool.query('SELECT 1 ok');
    res.json({ ok: true, db: r.rows[0].ok === 1, version: require('./package.json').version, uptime_s: Math.round(process.uptime()) });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
app.use((req, res, next) => { // tiny request log
  if (req.path.startsWith('/api')) console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path}`);
  next();
});

db.init().then(() => {
  app.use('/api', require('./src/routes/auth'));
  app.use('/api', require('./src/routes/config'));
  app.use('/api', require('./src/routes/sales'));
  app.use('/api', require('./src/routes/ops'));
  app.use('/api', require('./src/routes/portal'));
  app.use('/api', require('./src/routes/dash'));
  app.use('/api', require('./src/routes/commissions'));

  /* architecture one-pager + docs for judges: http://localhost:4300/docs/architecture.svg */
  app.use('/docs', express.static(path.join(__dirname, 'docs')));

  /* serve the React client; if it hasn't been built yet, show a helpful page (API stays live for tests) */
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  } else {
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>DealFlow360</title>
        <body style="font-family:system-ui;background:#F4F4F6;display:grid;place-items:center;height:100vh;margin:0">
          <div style="background:#fff;border-radius:12px;padding:34px 42px;max-width:520px;box-shadow:0 8px 30px rgba(0,0,0,.12)">
            <div style="font-size:38px">🏗️</div>
            <h1 style="margin:8px 0;color:#4E2E5E">DealFlow360 — client not built yet</h1>
            <p style="color:#555;line-height:1.6">The API and database are running. Build the React client with:
            <pre style="background:#F0EDF2;padding:10px 14px;border-radius:8px">npm run client:build</pre>
            then restart the server (or just run <b>start.bat</b>, which does everything).</p>
          </div>
        </body>`);
    });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

  app.use((err, req, res, _next) => {
    console.error('ERROR', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  });

  app.listen(PORT, async () => {
    const { ONE } = db;
    const n = (await ONE('SELECT COUNT(*) c FROM users')).c;
    console.log(`\n  DealFlow360 v2 running →  http://localhost:${PORT}`);
    console.log(`  PostgreSQL ready (dealflow360, ${n} users seeded)`);
    console.log(`  React client: ${fs.existsSync(CLIENT_DIST) ? 'served from client/dist' : 'not built yet (npm run client:build)'}\n`);
  });
}).catch((e) => {
  console.error('Failed to initialise database:', e.message);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION at:', p, 'reason:', reason);
});
process.on('exit', (code) => {
  console.log('PROCESS EXIT EVENT WITH CODE:', code);
});
