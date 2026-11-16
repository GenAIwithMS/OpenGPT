@echo off
REM ============================================================================
REM  OpenGPT - Windows startup script
REM  Starts the FastAPI backend (port 8000) and the React frontend (port 3000).
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

REM --- Start Backend ---------------------------------------------------------
if exist "%VENV%\Scripts\activate.bat" (
    start "Backend" cmd /k "call %VENV%\Scripts\activate.bat && cd /d %BACKEND% && python main.py"
) else (
    start "Backend" cmd /k "cd /d %BACKEND% && python main.py"
)

REM --- Start Frontend --------------------------------------------------------
start "Frontend" cmd /k "cd /d %FRONTEND% && npm install && npm run dev"

echo.
echo Starting backend (http://localhost:8000) and frontend (http://localhost:3000)...
echo Close the opened terminal windows to stop the servers.
endlocal
