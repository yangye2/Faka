@echo off
setlocal

cd /d "%~dp0"

echo [INFO] Working dir: %cd%

if not exist "node_modules" (
  echo [INFO] node_modules not found, installing dependencies...
  call npm install
  if errorlevel 1 goto :install_failed
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [INFO] .env created from .env.example
  )
)

echo [INFO] Starting server...
call npm start
exit /b %errorlevel%

:install_failed
echo [ERROR] npm install failed.
pause
exit /b 1
