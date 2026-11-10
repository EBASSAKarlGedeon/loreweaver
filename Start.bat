@echo off
title Loreweaver
pushd %~dp0
echo Starting Loreweaver...
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
::node server.js %*
node --use-system-ca server.js %*
pause
popd
