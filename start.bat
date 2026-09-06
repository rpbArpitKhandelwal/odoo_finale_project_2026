@echo off
title DealFlow360 v2 (React + Node + PostgreSQL)
cd /d "%~dp0"
echo ====================================================
echo   DealFlow360 v2 - starting...
echo   Browser:   http://localhost:4300
echo   Database:  PostgreSQL (dealflow360)
echo ====================================================
if not exist node_modules call npm install
if not exist client\node_modules (cd client && call npm install && cd ..)
if not exist client\dist (call npm run client:build)
start "" http://localhost:4300
node server.js
pause
