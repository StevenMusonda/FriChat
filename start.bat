@echo off
echo ========================================
echo FriChat - Quick Start Script
echo ========================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [1/4] Checking Node.js installation...
node --version
npm --version
echo.

REM Navigate to backend directory
cd backend

REM Check if node_modules exists
if not exist "node_modules\" (
    echo [2/4] Installing backend dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to install dependencies
        pause
        exit /b 1
    )
) else (
    echo [2/4] Dependencies already installed.
)
echo.

REM Check if .env exists
if not exist ".env" (
    echo [3/4] Creating .env file from template...
    copy .env.example .env
    echo [WARNING] Please configure .env file with your database credentials
    echo.
) else (
    echo [3/4] .env file already exists.
)
echo.

echo [4/4] Starting FriChat server...
echo.
echo ========================================
echo Server will start on http://localhost:3000
echo Frontend: http://localhost/FriChat
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

REM Start the server
npm start

pause
