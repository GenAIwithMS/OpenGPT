@echo off
REM ============================================================================
REM  OpenGPT - Windows startup script
REM  Starts the FastAPI backend (port 8000) and the React frontend (port 3000).
REM  If a port is already in use, the next free one is used instead.
REM  The backend starts the coding agent (Code page) itself when Bun is installed.
REM ============================================================================

setlocal
set ROOT=%~dp0
set BACKEND=%ROOT%backend
set FRONTEND=%ROOT%frontend
set VENV=%ROOT%.venv
set AGENT=%ROOT%coding-agent

REM --- Coding agent dependencies (once) --------------------------------------
REM The Code page needs Bun (https://bun.sh); chat works without it.
where bun >nul 2>nul
if errorlevel 1 (
    echo Bun is not installed: the Code page ^(coding agent^) will be unavailable.
    echo Install it from https://bun.sh to use it. Chat works without it.
) else (
    if not exist "%AGENT%\node_modules" (
        echo Installing the coding agent's dependencies ^(first run only^)...
        pushd "%AGENT%"
        call bun install
        if errorlevel 1 echo Coding agent install failed; the Code page will be unavailable.
        popd
    )
)

REM --- Ports -----------------------------------------------------------------
REM A port is taken when netstat shows a TCP line for it with a foreign
REM address ending in :0 (listening; this works in every Windows language).
REM No labels or goto here, so the file works with LF or CRLF line endings.

REM Backend: PORT from the environment, else from backend\.env, else 8000.
set "WANT_BACKEND=%PORT%"
if "%WANT_BACKEND%"=="" if exist "%BACKEND%\.env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /r /c:"^ *PORT *=" "%BACKEND%\.env"') do set "WANT_BACKEND=%%b"
)
if "%WANT_BACKEND%"=="" set "WANT_BACKEND=8000"
for /f "tokens=1 delims= #" %%c in ("%WANT_BACKEND:"=%") do set "WANT_BACKEND=%%c"
echo %WANT_BACKEND%| findstr /r "^[0-9][0-9]*$" >nul || set "WANT_BACKEND=8000"
set "WANT_FRONTEND=3000"

set /a LAST_BACKEND=WANT_BACKEND+19
set "BACKEND_PORT="
for /l %%p in (%WANT_BACKEND%,1,%LAST_BACKEND%) do if not defined BACKEND_PORT (
    netstat -an | findstr /r /c:"TCP.*:%%p .*:0 " >nul || set "BACKEND_PORT=%%p"
)
if not defined BACKEND_PORT (
    echo No free port found from %WANT_BACKEND% to %LAST_BACKEND%.
    exit /b 1
)

REM Frontend: from 3000, never the backend's port.
set /a LAST_FRONTEND=WANT_FRONTEND+20
set "FRONTEND_PORT="
for /l %%p in (%WANT_FRONTEND%,1,%LAST_FRONTEND%) do if not defined FRONTEND_PORT if not "%%p"=="%BACKEND_PORT%" (
    netstat -an | findstr /r /c:"TCP.*:%%p .*:0 " >nul || set "FRONTEND_PORT=%%p"
)
if not defined FRONTEND_PORT (
    echo No free port found from %WANT_FRONTEND% to %LAST_FRONTEND%.
    exit /b 1
)

if not "%BACKEND_PORT%"=="%WANT_BACKEND%" echo Port %WANT_BACKEND% is in use: the backend will use %BACKEND_PORT%.
if not "%FRONTEND_PORT%"=="%WANT_FRONTEND%" echo Port %WANT_FRONTEND% is in use: the frontend will use %FRONTEND_PORT%.
set "HAS_PUBLIC_URL="
if exist "%BACKEND%\.env" findstr /r /c:"^ *OPENGPT_PUBLIC_URL *=..*" "%BACKEND%\.env" >nul && set "HAS_PUBLIC_URL=1"
if not "%BACKEND_PORT%"=="%WANT_BACKEND%" if not defined HAS_PUBLIC_URL (
    echo   Connector sign-in now returns to port %BACKEND_PORT%. If you registered an OAuth app
    echo   with port %WANT_BACKEND% in its callback URL, stop what uses that port instead.
)

REM Read by backend\main.py and frontend\vite.config.js (the /api proxy).
set "PORT=%BACKEND_PORT%"
set "OPENGPT_BACKEND_PORT=%BACKEND_PORT%"
set "OPENGPT_FRONTEND_PORT=%FRONTEND_PORT%"
REM Let the frontend's address call the API, unless backend\.env sets its own list.
set "HAS_CORS="
if exist "%BACKEND%\.env" findstr /r /c:"^ *CORS_ORIGINS *=..*" "%BACKEND%\.env" >nul && set "HAS_CORS=1"
if not defined CORS_ORIGINS if not defined HAS_CORS set "CORS_ORIGINS=http://localhost:%FRONTEND_PORT%,http://127.0.0.1:%FRONTEND_PORT%"

REM --- Start Backend ---------------------------------------------------------
if exist "%VENV%\Scripts\activate.bat" (
    start "Backend" cmd /k "call %VENV%\Scripts\activate.bat && cd /d %BACKEND% && python main.py"
) else (
    start "Backend" cmd /k "cd /d %BACKEND% && python main.py"
)

REM --- Start Frontend --------------------------------------------------------
start "Frontend" cmd /k "cd /d %FRONTEND% && npm install && npm run dev"

echo.
echo Starting backend (http://localhost:%BACKEND_PORT%) and frontend (http://localhost:%FRONTEND_PORT%)...
echo Close the opened terminal windows to stop the servers.
endlocal
