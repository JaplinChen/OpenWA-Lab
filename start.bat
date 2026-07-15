@echo off
setlocal
cd /d "%~dp0"

echo [start] freeing ports 2785 / 2886...
for %%P in (2785 2886) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo   killing PID %%A on port %%P
    taskkill /F /PID %%A >nul 2>&1
  )
)

if not exist node_modules (
  echo [start] installing dependencies...
  call npm install || exit /b 1
)

echo [start] launching API + dashboard...
call npm run dev
