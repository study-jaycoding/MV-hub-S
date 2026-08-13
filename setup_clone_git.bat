@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo.
echo ============================================
echo  MV Hub first-time setup
echo ============================================
echo  Installs prerequisites when missing, then
echo  clones/updates the app on this Desktop.
echo.

if not exist "%ROOT%setup_clone_git.ps1" (
  echo [ERROR] setup_clone_git.ps1 is missing next to this file.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup_clone_git.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Setup stopped at the failed step above.
  pause
  exit /b 1
)

echo.
echo [done] First-time setup completed successfully.
pause
exit /b 0
