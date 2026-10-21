@echo off
rem Windows wrapper for cmd.exe: finds py or python and runs harness.py.
set "ROOT=%~dp0..\.."
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py "%ROOT%\harness.py" %*
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%ROOT%\harness.py" %*
  exit /b %ERRORLEVEL%
)
echo Python 3.8+ not found. Install from python.org or the Microsoft Store.
exit /b 1
