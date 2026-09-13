@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS, version 22 or newer, from https://nodejs.org/
  echo Then close this window and run setup.cmd again.
  pause
  exit /b 1
)
node "%~dp0setup.mjs" %*
set "setupResult=%errorlevel%"
if "%~1"=="" pause
exit /b %setupResult%
