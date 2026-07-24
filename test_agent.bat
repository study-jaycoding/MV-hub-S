@echo off
REM ============================================================================
REM  MV Hub - TEST AGENT (local generation test)   run on YOUR OWN PC
REM
REM  Same as MV_agent, but fully ISOLATED for testing the dev build:
REM    - PORT              8012                 (real MV_agent keeps 8010)
REM    - CONTENT_HUB_DATA  backend\data_test    (separate DB/media; real data untouched)
REM    - NO_PROXY          1                    (standalone; nothing pushed to team server)
REM
REM  Your Higgsfield CLI login is shared machine-wide, so the model list AND
REM  generation both work here.
REM
REM  WARNING: generation makes REAL Higgsfield jobs and spends REAL credits.
REM  The isolation is only about the DB and the team server - NOT credits.
REM
REM  Stop: close this window (stops the hub and the agent), same as MV_agent.
REM ============================================================================
set "PORT=8012"
set "CONTENT_HUB_DATA=%~dp0backend\data_test"
REM Read the pulled server DB directly (test_pull-db.bat puts it here). Without this,
REM per-account splitting (active.json -> data/db/acct/<uid>/) makes the hub read an
REM empty account DB and the copied projects/generations do not show.
set "CONTENT_HUB_DB=%~dp0backend\data_test\db\content_hub.db"
set "CONTENT_HUB_NO_PROXY=1"
call "%~dp0MV_agent.bat"
