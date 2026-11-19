# OpenGPT: backend, built frontend and the coding agent in one image.
# MySQL runs separately (see docker-compose.yml). Configure with environment
# variables (backend/.env.example lists them); nothing secret is in the image.
#
#   docker compose up          # with MySQL, on http://localhost:8000
#
# The app listens on 0.0.0.0 inside the container (BIND_HOST) but treats
# itself as local (HOST=127.0.0.1): publish the port on 127.0.0.1 only
# (-p 127.0.0.1:8000:8000), or set HOST=0.0.0.0 and API_TOKEN to open it
# to your network.

# ---------------------------------------------------------------- frontend
FROM docker.io/library/node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- bun
FROM docker.io/oven/bun:1.3.14-debian AS bun

# ---------------------------------------------------------------- app
FROM docker.io/library/python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git and ripgrep for the coding agent; curl for the health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Python packages. The CPU build of PyTorch (for document embeddings) keeps
# the image gigabytes smaller than the default CUDA build.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.13.0 \
    && pip install -r backend/requirements.txt

# The coding agent's packages.
COPY coding-agent/ coding-agent/
# Fewer parallel downloads: the default can stall on slow connections.
RUN cd coding-agent && bun install --frozen-lockfile --network-concurrency=16

COPY backend/ backend/
COPY LICENSE ./
COPY --from=frontend /src/frontend/dist /app/frontend/dist

# Run as a normal user; /data holds everything that must survive restarts.
RUN useradd --create-home --uid 1000 opengpt \
    && mkdir -p /data/projects /data/cache /app/backend/app/storage \
    && chown -R opengpt:opengpt /data /app/backend/app/storage
USER opengpt

ENV HOST=127.0.0.1 \
    BIND_HOST=0.0.0.0 \
    PORT=8000 \
    FRONTEND_DIST=/app/frontend/dist \
    BUN_PATH=/usr/local/bin/bun \
    CODE_PROJECTS_ROOT=/data/projects \
    CODE_ALLOWED_ROOTS=/data/projects \
    HF_HOME=/data/cache/huggingface

WORKDIR /app/backend
EXPOSE 8000
VOLUME ["/app/backend/app/storage", "/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["python", "main.py"]
