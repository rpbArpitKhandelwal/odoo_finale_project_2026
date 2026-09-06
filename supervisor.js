/* DealFlow360 — High-Availability Supervisor */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

function start() {
  console.log(`[Supervisor] Launching DealFlow360 server.js...`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('exit', (code, signal) => {
    console.warn(`[Supervisor] Server exited (code: ${code}, signal: ${signal}). Auto-restarting in 500ms...`);
    setTimeout(start, 500);
  });

  child.on('error', (err) => {
    console.error(`[Supervisor] Spawn error:`, err);
    setTimeout(start, 1000);
  });
}

start();
