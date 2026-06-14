@echo off
rem Workpad launcher - starts the app with the bundled Electron (no install).
rem Double-click this file, or use the desktop shortcut.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
