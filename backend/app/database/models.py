"""
SQLAlchemy ORM Models for Chatbot Database
"""
from sqlalchemy import Column, String, Integer, TIMESTAMP, LargeBinary, Index
from sqlalchemy.dialects.mysql import LONGBLOB
from sqlalchemy.orm import declarative_base
from sqlalchemy.sql import func

Base = declarative_base()

# Checkpoints hold the whole conversation, which quickly outgrows MySQL's plain
# BLOB (64 KB). LONGBLOB allows up to 4 GB; other databases keep LargeBinary.
BigBinary = LargeBinary().with_variant(LONGBLOB(), "mysql")


class ThreadMetadata(Base):
    """Thread metadata table - stores conversation thread information"""
    __tablename__ = "thread_metadata"
    
    thread_id = Column(String(191), primary_key=True)
    title = Column(String(255), nullable=False, default="New Chat")
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    __table_args__ = (
        Index("idx_created_at", "created_at"),
        Index("idx_updated_at", "updated_at"),
    )


class Checkpoint(Base):
    """Checkpoints table - stores LangGraph conversation state"""
    __tablename__ = "checkpoints"
    
    thread_id = Column(String(191), primary_key=True)
    checkpoint_ns = Column(String(191), primary_key=True, default="")
    checkpoint_id = Column(String(191), primary_key=True)
    parent_checkpoint_id = Column(String(191), nullable=True)
    type = Column(String(128), nullable=True)
    checkpoint = Column(BigBinary, nullable=False)
    meta = Column(BigBinary, nullable=False)
    
    __table_args__ = (
        Index("idx_parent", "thread_id", "checkpoint_ns", "parent_checkpoint_id"),
    )


class CheckpointWrite(Base):
    """Checkpoint writes table - stores pending checkpoint writes"""
    __tablename__ = "checkpoint_writes"
    
    thread_id = Column(String(191), primary_key=True)
    checkpoint_ns = Column(String(191), primary_key=True, default="")
    checkpoint_id = Column(String(191), primary_key=True)
    task_id = Column(String(191), primary_key=True)
    idx = Column(Integer, primary_key=True)
    channel = Column(String(128), nullable=False)
    type = Column(String(128), nullable=True)
    value = Column(BigBinary, nullable=True)
    # No foreign key to checkpoints (like LangGraph's own savers): the saver
    # deletes writes together with their checkpoint, and a foreign key would
    # force it to invent placeholder checkpoints.
