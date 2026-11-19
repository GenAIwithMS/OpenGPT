import os

from app.observability import configure_langsmith

configure_langsmith()

import logging
import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from app.router.chat import chat_router
from app.router.health import health_router
from app.router.code import code_router
from app.router.settings import settings_router
from app.router.skills import skills_router
from app.router.providers import providers_router
from app.router.connectors import connectors_callback_router, connectors_router
from app.router.connectors import refresh_loop as connectors_refresh_loop
from app.services.coding_agent.process import agent as coding_agent
from app.services import mcp_tools
from app.services.coding_agent import client as coding_agent_client
from app.database.init_db import DatabaseInitError, init_database
from app.error_handlers import register_error_handlers
from app import llm
from app.security import is_local_host, require_api_token
from app.tools.blogs.reducer import BLOG_IMAGE_DIR, BLOG_IMAGE_URL


def _docs_enabled() -> bool:
    """API docs are on for local use and off when exposed, unless ENABLE_DOCS says otherwise."""
    flag = os.getenv("ENABLE_DOCS")
    if flag is not None:
        return flag.strip().lower() in {"1", "true", "yes", "on"}
    return is_local_host(os.getenv("HOST", "127.0.0.1"))


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # The coding agent starts in the background; the chat doesn't wait for it.
    coding_agent.start()
    # Keeps connector sign-ins (OAuth tokens) fresh.
    stop_refresh = threading.Event()
    threading.Thread(target=connectors_refresh_loop, args=(stop_refresh,), daemon=True).start()
    # Connect chat's connectors in the background.
    mcp_tools.warm()
    try:
        yield
    finally:
        stop_refresh.set()
        await asyncio.to_thread(mcp_tools.close_all)
        await coding_agent_client.close()
        coding_agent.stop()


def create_app():
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(levelname)s %(name)s: %(message)s",
    )

    docs = _docs_enabled()
    app = FastAPI(
        title="OpenGPT API",
        description="FastAPI backend for OpenGPT, a LangGraph-powered chatbot with multi-thread support",
        version="1.0.0",
        docs_url="/docs" if docs else None,
        redoc_url="/redoc" if docs else None,
        openapi_url="/openapi.json" if docs else None,
        lifespan=_lifespan,
    )

    register_error_handlers(app)

    # Configure CORS
    # Only the frontend may call the API from a browser. A wildcard would let
    # any website you visit read and change your chats. Override with a
    # comma-separated CORS_ORIGINS env var.
    origins = [
        o.strip()
        for o in os.getenv(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
        if o.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
    )
    

    try:
        init_database()
    except DatabaseInitError as e:
        # Stop here with a clear message instead of serving 500s.
        raise SystemExit(f"Startup failed: {e}") from e

    # After the database: the active provider may be one saved in Settings > Developer.
    try:
        llm.reload()
        llm.validate()
    except llm.LLMConfigError as e:
        raise SystemExit(f"Startup failed: {e}") from e
            
    # Include routers
    # Every chat route needs the API token when API_TOKEN is set.
    app.include_router(
        chat_router, prefix="/api", tags=["chat"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(
        code_router, prefix="/api", tags=["code"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(
        settings_router, prefix="/api", tags=["settings"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(
        connectors_router, prefix="/api", tags=["connectors"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(
        skills_router, prefix="/api", tags=["skills"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(
        providers_router, prefix="/api", tags=["providers"], dependencies=[Depends(require_api_token)]
    )
    # Sign-in callback: a browser redirect from the provider, so no API token;
    # protected by the single-use OAuth state instead.
    app.include_router(connectors_callback_router, prefix="/api", tags=["connectors"])
    app.include_router(health_router, prefix="/api", tags=["health"])

    # Blog images (random file names) so the chat can show them. Served
    # without the API token: <img> tags can't send one.
    BLOG_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    app.mount(BLOG_IMAGE_URL, StaticFiles(directory=BLOG_IMAGE_DIR), name="blog-images")
    _serve_frontend(app)
    return app


def _serve_frontend(app: FastAPI) -> None:
    """Serve the built frontend (FRONTEND_DIST, set in the Docker image) on the
    same port as the API, so the page calls /api on its own address: no CORS
    and no token built into the page. Unknown paths get index.html, because
    the frontend has its own routes (/c/<id>, /code, ...)."""
    from fastapi.responses import FileResponse

    from app.exceptions import NotFoundError

    dist = os.getenv("FRONTEND_DIST", "").strip()
    if not dist or not os.path.isfile(os.path.join(dist, "index.html")):
        return
    root = os.path.realpath(dist)
    index = os.path.join(root, "index.html")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise NotFoundError("Not found")
        file = os.path.realpath(os.path.join(root, path))
        if path and file.startswith(root + os.sep) and os.path.isfile(file):
            return FileResponse(file)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

