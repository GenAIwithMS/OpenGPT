#!/usr/bin/env bash
# ============================================================================
#  OpenGPT - Linux/Mac startup script
#  Starts the FastAPI backend (port 8000) and the React frontend (port 3000).
#  The backend starts the coding agent (Code page) itself when Bun is installed.
# ============================================================================

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$ROOT/.venv"
AGENT="$ROOT/coding-agent"

# --- Coding agent dependencies (once) ---------------------------------------
# The Code page needs Bun (https://bun.sh); chat works without it.
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -n "$BUN" ]; then
    if [ ! -d "$AGENT/node_modules" ]; then
        echo "Installing the coding agent's dependencies (first run only)..."
        ( cd "$AGENT" && "$BUN" install ) || echo "Coding agent install failed; the Code page will be unavailable."
    fi
else
    echo "Bun is not installed: the Code page (coding agent) will be unavailable."
    echo "Install it from https://bun.sh to use it. Chat works without it."
fi

# --- Start Backend ----------------------------------------------------------
if [ -f "$VENV/bin/activate" ]; then
    ( cd "$BACKEND" && bash -c "source '$VENV/bin/activate' && python main.py" ) &
else
    ( cd "$BACKEND" && python main.py ) &
fi
BACKEND_PID=$!

# --- Start Frontend ---------------------------------------------------------
( cd "$FRONTEND" && npm install && npm run dev ) &
FRONTEND_PID=$!

echo ""
echo "Starting backend (http://localhost:8000) and frontend (http://localhost:3000)..."
echo "Press Ctrl+C to stop both servers."

cleanup() {
    echo ""
    echo "Stopping servers..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
trap cleanup INT TERM

wait
