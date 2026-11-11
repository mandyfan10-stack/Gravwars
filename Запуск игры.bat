@echo off
title GravWars
set "PATH=%PATH%;C:\Program Files\nodejs"
cd /d "%~dp0"
if exist "gravity-bedwars\package.json" cd /d "%~dp0gravity-bedwars"

if not exist "node_modules\vite\bin\vite.js" (
    echo Installing dependencies...
    call "C:\Program Files\nodejs\npm.cmd" install
)

echo ============================================
echo   GravWars is starting...
echo   Opening http://localhost:5173 in browser
echo   Close this window to stop the game server
echo ============================================
echo.

"C:\Program Files\nodejs\node.exe" "node_modules\vite\bin\vite.js" --open
pause
