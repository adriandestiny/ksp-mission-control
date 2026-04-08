@echo off
title KSP Artemis Mission Control Server
color 0B

echo ============================================================
echo   KSP Artemis Mission Control Server
echo ============================================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.9+ from python.org
    pause
    exit /b 1
)

:: Install dependencies if needed
echo [INFO] Checking dependencies...
pip install -q -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [INFO] Starting Mission Control Server...
echo [INFO] Dashboard will be available at: http://localhost:5000
echo [INFO] Make sure KSP is running with the kRPC mod active!
echo.
echo Press Ctrl+C to stop the server.
echo ============================================================
echo.

python server.py

pause
