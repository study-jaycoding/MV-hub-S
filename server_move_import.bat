@echo off
REM MV Hub - verify (default) or install a server migration package on this PC.
REM
REM Verification changes nothing: it restores the set into an isolated folder,
REM boots an isolated server and checks login. Add --install to replace the
REM live databases. The server MUST be fully stopped for --install.
REM
REM Usage:
REM   server_move_import.bat <package folder>
REM   server_move_import.bat <package folder> --install
REM   server_move_import.bat --backup-set "<dir>\content_hub_<stamp>.db" --install
REM
REM The --backup-set form recovers straight from a NAS automatic backup when no
REM export package exists (dead server PC). See docs\SERVER_MIGRATION.md.
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  echo Usage: server_move_import.bat ^<package folder^> [--install]
  echo        server_move_import.bat --backup-set "<dir>\content_hub_<stamp>.db" [--install]
  echo.
  echo   Without --install nothing is changed - it only verifies.
  echo   Details: docs\SERVER_MIGRATION.md
  exit /b 1
)
call "%ROOT%run_py.bat" "%ROOT%tools\server_move.py" import %*
exit /b %errorlevel%
