@echo off
rem Tool A SN station - open in Edge app window (Chrome fallback)
set PAGE=%~dp0index.html
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%EDGE%" ( start "" "%EDGE%" --app="%PAGE%" & goto :eof )
if exist "%CHROME%" ( start "" "%CHROME%" --app="%PAGE%" & goto :eof )
start "" "%PAGE%"
