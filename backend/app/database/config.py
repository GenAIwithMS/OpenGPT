"""MySQL Database Configuration"""
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from urllib.parse import quote_plus

load_dotenv()


class DatabaseConfig:
    """Database configuration"""
    
    HOST = os.getenv("MYSQL_HOST", "localhost")
    PORT = int(os.getenv("MYSQL_PORT", "3306"))
    USER = os.getenv("MYSQL_USER", "root")
    PASSWORD = os.getenv("MYSQL_PASSWORD", "")
    DATABASE = os.getenv("MYSQL_DATABASE", "chatbot_db")
    
    _engine = None
    _session_factory = None
    
    @classmethod
    def get_connection_url(cls) -> str:
        """Get MySQL connection URL"""
        password = quote_plus(cls.PASSWORD) if cls.PASSWORD else ""
        return f"mysql+pymysql://{cls.USER}:{password}@{cls.HOST}:{cls.PORT}/{cls.DATABASE}?charset=utf8mb4"
    
    @classmethod
    def get_engine(cls):
        """Get SQLAlchemy engine"""
        if cls._engine is None:
            cls._engine = create_engine(
                cls.get_connection_url(),
                pool_pre_ping=True,
                pool_recycle=3600
            )
        return cls._engine
    
    @classmethod
    def get_session_factory(cls):
        """Get session factory"""
        if cls._session_factory is None:
            cls._session_factory = sessionmaker(bind=cls.get_engine())
        return cls._session_factory
