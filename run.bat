@echo off
setlocal
chcp 65001 >nul
title Fotbalové tipy
cd /d "%~dp0"

rem --- 1) najdi Python (preferuje se launcher "py", jinak "python") ---
set "PYCMD="
where py >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3"
if not defined PYCMD (
    where python >nul 2>nul
    if not errorlevel 1 set "PYCMD=python"
)
if not defined PYCMD (
    echo Python nebyl nalezen.
    echo Nainstalujte Python 3.10 nebo novější z https://www.python.org/downloads/
    echo a při instalaci zaškrtněte "Add python.exe to PATH".
    pause
    exit /b 1
)

rem --- 2) virtuální prostředí (vytvoří se jen při prvním spuštění) ---
if not exist ".venv\Scripts\python.exe" (
    echo První spuštění: vytvářím virtuální prostředí...
    %PYCMD% -m venv .venv
    if errorlevel 1 (
        echo Nepodařilo se vytvořit virtuální prostředí.
        pause
        exit /b 1
    )
)

rem --- 3) závislosti (znovu se instalují, jen když se změnil requirements.txt) ---
fc /b "requirements.txt" ".venv\requirements.installed" >nul 2>nul
if errorlevel 1 (
    echo Instaluji potřebné balíčky, chvíli to potrvá...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo Instalace balíčků selhala. Zkontrolujte připojení k internetu.
        pause
        exit /b 1
    )
    copy /y "requirements.txt" ".venv\requirements.installed" >nul
)

rem --- 4) spuštění aplikace ---
".venv\Scripts\python.exe" main.py %*
if errorlevel 1 (
    echo.
    echo Aplikace skončila s chybou. Podrobnosti jsou v data\tipster.log
    pause
)
endlocal
