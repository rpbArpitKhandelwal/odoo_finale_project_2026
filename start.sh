#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -d client/node_modules ] || (cd client && npm install && cd ..)
[ -d client/dist ] || npm run client:build
echo "DealFlow360 v2 → http://localhost:4300 (PostgreSQL)"
( sleep 1 && (xdg-open http://localhost:4300 || open http://localhost:4300) ) >/dev/null 2>&1 &
node server.js
