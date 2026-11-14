import os

from app.observability import configure_langsmith

configure_langsmith()

import logging

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from app.router.chat import chat_router
from app.router.health import health_router
from app.database.init_db import DatabaseInitError, init_database
from app.error_handlers import register_error_handlers
from app.security import is_local_host, require_api_token
from app.tools.blogs.reducer import BLOG_IMAGE_DIR, BLOG_IMAGE_URL


def _docs_enabled() -> bool:
    """API docs are on for local use and off when exposed, unless ENABLE_DOCS says otherwise."""
    flag = os.getenv("ENABLE_DOCS")
    if flag is not None:
        return flag.strip().lower() in {"1", "true", "yes", "on"}
    return is_local_host(os.getenv("HOST", "127.0.0.1"))


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
            
    # Include routers
    # Every chat route needs the API token when API_TOKEN is set.
    app.include_router(
        chat_router, prefix="/api", tags=["chat"], dependencies=[Depends(require_api_token)]
    )
    app.include_router(health_router, prefix="/api", tags=["health"])

    # Blog images (random file names) so the chat can show them. Served
    # without the API token: <img> tags can't send one.
    BLOG_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    app.mount(BLOG_IMAGE_URL, StaticFiles(directory=BLOG_IMAGE_DIR), name="blog-images")
    return app

