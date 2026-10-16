@echo off
rem qiqi.help render station: the tray icon, and the window. Double-click to open.
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0station.ps1" -Open
