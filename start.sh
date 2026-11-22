#!/usr/bin/env bash
# ============================================================================
#  OpenGPT - Linux/Mac startup script
#  Starts the FastAPI backend (port 8000) and the React frontend (port 3000).
#  If a port is already in use, the next free one is used instead.
#  The backend starts the coding agent (Code page) itself when Bun is installed,
#  and the agent's browser when Node.js 24 is installed.
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

# --- Ports ------------------------------------------------------------------
# Something answering on 127.0.0.1 or ::1 means the port is taken.
port_in_use() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
    (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null && return 0
    return 1
}

# The first free port from $1, trying up to 20.
free_port() {
    local port=$1
    for _ in $(seq 1 20); do
        if ! port_in_use "$port"; then echo "$port"; return 0; fi
        port=$((port + 1))
    done
    return 1
}

# A setting from backend/.env (no quotes or comments), or empty.
env_value() {
    [ -f "$BACKEND/.env" ] || return 0
    grep -E "^[[:space:]]*$1[[:space:]]*=" "$BACKEND/.env" | tail -n 1 \
        | cut -d= -f2- | sed -e 's/[[:space:]]#.*//' -e 's/["'"'"'\r[:space:]]//g'
}

WANT_BACKEND="${PORT:-$(env_value PORT)}"
case "$WANT_BACKEND" in ''|*[!0-9]*) WANT_BACKEND=8000 ;; esac
WANT_FRONTEND=3000

BACKEND_PORT="$(free_port "$WANT_BACKEND")" || { echo "No free port found from $WANT_BACKEND to $((WANT_BACKEND + 19))."; exit 1; }
FRONTEND_PORT="$(free_port "$WANT_FRONTEND")" || { echo "No free port found from $WANT_FRONTEND to $((WANT_FRONTEND + 19))."; exit 1; }
# The two must differ (e.g. if PORT is set to 3000).
if [ "$FRONTEND_PORT" = "$BACKEND_PORT" ]; then
    FRONTEND_PORT="$(free_port $((BACKEND_PORT + 1)))" || { echo "No free port found for the frontend."; exit 1; }
fi

[ "$BACKEND_PORT" != "$WANT_BACKEND" ] && echo "Port $WANT_BACKEND is in use: the backend will use $BACKEND_PORT."
[ "$FRONTEND_PORT" != "$WANT_FRONTEND" ] && echo "Port $WANT_FRONTEND is in use: the frontend will use $FRONTEND_PORT."
if [ "$BACKEND_PORT" != "$WANT_BACKEND" ] && [ -z "$(env_value OPENGPT_PUBLIC_URL)" ]; then
    echo "  Connector sign-in now returns to port $BACKEND_PORT. If you registered an OAuth app"
    echo "  with port $WANT_BACKEND in its callback URL, stop what uses that port instead."
fi

export PORT="$BACKEND_PORT"                 # read by backend/main.py
export OPENGPT_BACKEND_PORT="$BACKEND_PORT" # read by frontend/vite.config.js (the /api proxy)
export OPENGPT_FRONTEND_PORT="$FRONTEND_PORT"
# Let the frontend's address call the API, unless backend/.env sets its own list.
if [ -z "${CORS_ORIGINS:-}" ] && [ -z "$(env_value CORS_ORIGINS)" ]; then
    export CORS_ORIGINS="http://localhost:$FRONTEND_PORT,http://127.0.0.1:$FRONTEND_PORT"
fi

# --- Browser engine (once, and after it changes) ----------------------------
# The agent's browser needs Node.js 24: BROWSER_ENGINE_NODE (environment or
# backend/.env), or node on PATH. Chat and the Agent page work without it.
ENGINE="$BACKEND/browser_engine"
ENGINE_NODE="${BROWSER_ENGINE_NODE:-$(env_value BROWSER_ENGINE_NODE)}"
[ -z "$ENGINE_NODE" ] && ENGINE_NODE="$(command -v node || true)"
ENGINE_MAJOR="$([ -n "$ENGINE_NODE" ] && "$ENGINE_NODE" --version 2>/dev/null | sed -e 's/^v//' -e 's/\..*//')"
if [ "$ENGINE_MAJOR" = "24" ]; then
    export BROWSER_ENGINE_NODE="$ENGINE_NODE"
    NODE_BIN="$(dirname "$ENGINE_NODE")"
    if [ ! -f "$ENGINE/dist/.built" ] || [ -n "$(find "$ENGINE/typescript" "$ENGINE/package.json" -newer "$ENGINE/dist/.built" -print -quit 2>/dev/null)" ]; then
        echo "Building the browser engine (first run, or after an update)..."
        (
            cd "$ENGINE" && export PATH="$NODE_BIN:$PATH" \
            && if command -v pnpm >/dev/null; then PNPM=pnpm; else PNPM="corepack pnpm"; fi \
            && $PNPM install --frozen-lockfile && $PNPM build \
            && node node_modules/playwright/cli.js install chromium \
            && touch dist/.built
        ) || echo "The browser engine didn't build; the agent's browser will be unavailable (see Settings > Browser)."
    fi
else
    echo "Node.js 24 not found: the agent's browser will be unavailable. Install Node.js 24, or set"
    echo "BROWSER_ENGINE_NODE to a Node.js 24 binary. Chat and the Agent page work without it."
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
echo "Starting backend (http://localhost:$BACKEND_PORT) and frontend (http://localhost:$FRONTEND_PORT)..."
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
