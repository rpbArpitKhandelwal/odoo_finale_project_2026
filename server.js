/* DealFlow360 — server entrypoint */
'use strict';
const express = require('express');
const path = require('path');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 4300;

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { // tiny request log
  if (req.path.startsWith('/api')) console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path}`);
  next();
});

app.use('/api', require('./src/routes/auth'));
app.use('/api', require('./src/routes/config'));
app.use('/api', require('./src/routes/sales'));
app.use('/api', require('./src/routes/ops'));
app.use('/api', require('./src/routes/portal'));
app.use('/api', require('./src/routes/dash'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, _next) => {
  console.error('ERROR', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  const n = db.db.prepare('SELECT COUNT(*) c FROM users').get().c;
  console.log(`\n  DealFlow360 running →  http://localhost:${PORT}`);
  console.log(`  Database ready (${n} users seeded)\n`);
});
