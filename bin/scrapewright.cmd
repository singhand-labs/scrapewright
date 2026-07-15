@echo off
rem Unified Scrapewright CLI (Windows). Delegates to node.
setlocal
set DIR=%~dp0
node "%DIR%..\native-host\scrapewright.js" %*
