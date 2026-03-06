@echo off
title RACE READY — Serwer
color 0A
echo.
echo  ==========================================
echo   RACE READY — uruchamianie serwera...
echo  ==========================================
echo.

:: Sprawdz czy Node.js jest zainstalowany
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  BLAD: Node.js nie jest zainstalowany!
    echo.
    echo  Pobierz Node.js ze strony: https://nodejs.org
    echo  Wybierz wersje LTS i zainstaluj.
    echo  Potem uruchom ten plik ponownie.
    echo.
    pause
    exit /b 1
)

:: Przejdz do folderu gdzie jest ten plik
cd /d "%~dp0"

:: Uruchom serwer
echo  Serwer startuje... nie zamykaj tego okna!
echo.
node server.js
pause
