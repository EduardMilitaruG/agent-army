@echo off
rem Starts Agent Army in the background (if not already running) and opens the app window.
rem Settings (max parallel workers etc.) are in config.json.
wscript "%~dp0launcher\agent-army.vbs" /open
