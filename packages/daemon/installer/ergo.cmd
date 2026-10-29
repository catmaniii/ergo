@echo off
rem ergo command (ticket 318): find the bundled node and run app\packages\daemon\src\cli\main.js with the same arguments.
rem Same job as ergo.exe (used when ergo.exe cannot be built or is blocked by antivirus software).
rem In <install dir>\bin it reads ..\current: one line of text with the name of the version directory in use.
rem Older installs have ..\current as a junction pointing at the version directory; both are accepted.
rem Inside a version directory it uses its own directory.
rem This file is ASCII only on purpose: cmd.exe reads batch files in the console code page.
setlocal
set "ERGO_HOME=%~dp0"
if exist "%ERGO_HOME%ergo.json" goto :havehome
call :findcurrent
if not exist "%ERGO_HOME%ergo.json" goto :nohome
:havehome
set "ERGO_NODE=%ERGO_HOME%node\node.exe"
if exist "%ERGO_NODE%" goto :run
if not exist "%ERGO_HOME%node.path" goto :nonode
set /p ERGO_NODE=<"%ERGO_HOME%node.path"
:run
set "ERGO_LAUNCHER=%~f0"
"%ERGO_NODE%" "%ERGO_HOME%app\packages\daemon\src\cli\main.js" %*
exit /b %ERRORLEVEL%

:findcurrent
rem the version directory named by ..\current (a one-line text file)
set "ERGO_VERSION="
if exist "%~dp0..\current" for /f "usebackq delims=" %%i in ("%~dp0..\current") do set "ERGO_VERSION=%%i"
if not defined ERGO_VERSION goto :oldcurrent
if exist "%~dp0..\versions\%ERGO_VERSION%\ergo.json" set "ERGO_HOME=%~dp0..\versions\%ERGO_VERSION%\"
exit /b 0
:oldcurrent
rem older installs: ..\current is a junction to the version directory
set "ERGO_HOME=%~dp0..\current\"
exit /b 0

:nohome
echo ergo: cannot find the installed version ^(..\current is missing or points at a version that is not installed^). Please reinstall. 1>&2
exit /b 1

:nonode
echo ergo: no node\node.exe or node.path in %ERGO_HOME%. Please reinstall. 1>&2
exit /b 1
