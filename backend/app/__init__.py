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
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    

    init_database()
            
    # Include routers
    app.include_router(chat_router, prefix="/api", tags=["chat"])
    app.include_router(health_router, prefix="/api", tags=["health"])
    return app

