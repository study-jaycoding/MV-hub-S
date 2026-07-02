@echo off
REM ============================================================================
REM  MV Hub - OPEN TEST   (run on YOUR LOCAL PC)
REM
REM  Opens the TEST server (running on the server via test_run-server.bat)
REM  in your browser:  http://<SERVER_IP>:<PORT>
REM
REM  This does NOT start anything locally - it only opens the remote test URL.
REM  If it does not load: make sure test_run-server.bat is running on the
REM  server, the server firewall allows port 8011, and SERVER_IP below is right.
REM ============================================================================
setlocal
REM --- Change these if your server address/port differ ---
set "SERVER_IP=192.168.1.199"
set "PORT=8011"

echo Opening test server: http://%SERVER_IP%:%PORT%
start "" "http://%SERVER_IP%:%PORT%"
