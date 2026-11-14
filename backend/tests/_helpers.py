"""Shared test setup: no MySQL, no model API keys, no network."""
import os

# Settings the app needs to import; nothing is called over the network.
os.environ.setdefault("LLM_PROVIDER", "openai")
os.environ.setdefault("LLM_API_KEY", "test-key")
os.environ.setdefault("LLM_MODEL", "test-model")
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ.setdefault("RATE_LIMIT_PER_MINUTE", "0")


def use_sqlite():
    """Point the database layer at an in-memory SQLite database with all tables."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.database.config import DatabaseConfig
    from app.database.models import Base

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    DatabaseConfig._engine = engine
    DatabaseConfig._session_factory = sessionmaker(bind=engine)
    return engine
