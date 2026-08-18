@echo off
REM ============================================================
REM  Starts the ingest server. Double-click this file.
REM  Leave the window open while collecting; close it when done.
REM ============================================================
title Bittensor Discord - Ingest Server

cd /d "%~dp0server"

if not exist ".env" (
  echo Creating .env from .env.example ...
  copy /y ".env.example" ".env" >nul
)

if not exist "node_modules" (
  echo Installing dependencies, one moment ...
  call npm install --no-audit --no-fund
  call npm approve-scripts esbuild
)

echo.
echo Starting ingest server on http://127.0.0.1:8787
echo Press Ctrl+C to stop.
echo.

call npm run dev

REM Keep the window open if the server exits so the error stays readable.
echo.
echo Server stopped.
pause
