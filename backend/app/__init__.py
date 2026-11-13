import os

from app.observability import configure_langsmith

configure_langsmith()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.router.chat import chat_router
from app.router.health import health_router
from app.database.init_db import init_database
from app.error_handlers import register_error_handlers


def create_app():
    app = FastAPI(
        title="OpenGPT API",
        description="FastAPI backend for OpenGPT, a LangGraph-powered chatbot with multi-thread support",
        version="1.0.0"
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
        allow_headers=["Content-Type"],
    )
    

    init_database()
            
    # Include routers
    app.include_router(chat_router, prefix="/api", tags=["chat"])
    app.include_router(health_router, prefix="/api", tags=["health"])
    return app

