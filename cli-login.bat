@echo off
chcp 65001 >nul
REM ============================================================================
REM  cli-login - check / switch the Higgsfield CLI account on THIS PC.
REM
REM  Run this when you want to log the local Higgsfield CLI into a DIFFERENT
REM  account before launching MV_agent.bat. Generations are pushed under the
REM  CLI account, and the hub login must use the SAME email - so set the CLI
REM  account here first, then open the hub and log in with the same email.
REM
REM  Login is browser-based (device login): a browser window opens; sign in
REM  there. There is no way to type the password directly in this window.
REM ============================================================================
setlocal

set "HF=higgsfield"
where higgsfield >nul 2>nul || set "HF=hf"
where %HF% >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Higgsfield CLI not found on this PC.
  echo         Run MV_agent.bat once - it installs the CLI for you.
  echo.
  pause
  exit /b 1
)

REM Not logged in yet? Go straight to login.
call %HF% account status >nul 2>nul
if errorlevel 1 goto :login

:show
echo.
echo  ===========================================================================
echo   CURRENT HIGGSFIELD CLI ACCOUNT
echo  ===========================================================================
call %HF% account status
echo  ===========================================================================
set "_sw="
set /p "_sw=  Switch to a DIFFERENT account? (y/N): "
if /i "%_sw%"=="y" goto :switch
echo.
echo  Done. The CLI stays logged in to the account shown above.
echo  Now launch MV_agent.bat and log in to the hub with the SAME email.
echo.
pause
exit /b 0

:switch
echo     Logging out the current account...
call %HF% auth logout >nul 2>nul
:login
echo     Sign in to your Higgsfield account (a browser window will open)...
call %HF% auth login
goto :show
