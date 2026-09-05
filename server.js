/* DealFlow360 — server entrypoint (Node.js + Express + PostgreSQL + React client) */
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 4300;

const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
const LEGACY_PUBLIC = path.join(__dirname, 'public');

app.use(express.json({ limit: '2mb' }));
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

  /* serve the React client when built; legacy vanilla UI stays reachable as a fallback */
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      if (req.path.startsWith('/legacy')) return next();
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }
  app.use('/legacy', express.static(LEGACY_PUBLIC));

  app.use('/api', (req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));
  app.use((req, res) => res.status(404).send('Not found'));

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
