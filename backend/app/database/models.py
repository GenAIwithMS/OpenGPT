"""
SQLAlchemy ORM Models for Chatbot Database
"""
from sqlalchemy import Boolean, Column, String, Integer, TIMESTAMP, LargeBinary, Index, Text
from sqlalchemy.dialects.mysql import LONGBLOB, LONGTEXT
from sqlalchemy.orm import declarative_base
from sqlalchemy.sql import func

Base = declarative_base()

# Checkpoints hold the whole conversation, which quickly outgrows MySQL's plain
# BLOB (64 KB). LONGBLOB allows up to 4 GB; other databases keep LargeBinary.
BigBinary = LargeBinary().with_variant(LONGBLOB(), "mysql")
# Long text (agent tasks, results, event data): plain TEXT is 64 KB in MySQL.
BigText = Text().with_variant(LONGTEXT(), "mysql")


class ThreadMetadata(Base):
    """Thread metadata table - stores conversation thread information"""
    __tablename__ = "thread_metadata"
    
    thread_id = Column(String(191), primary_key=True)
    title = Column(String(255), nullable=False, default="New Chat")
    # The project this chat belongs to (app/services/projects.py), if any.
    project_id = Column(String(36), nullable=True)
    # Pinned chats are listed first.
    pinned = Column(Boolean, nullable=False, default=False, server_default="0")
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    __table_args__ = (
        Index("idx_created_at", "created_at"),
        Index("idx_updated_at", "updated_at"),
        Index("idx_thread_project", "project_id"),
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


class AppSetting(Base):
    """App settings, one JSON value per section (profile, general, ...)."""
    __tablename__ = "app_settings"

    key = Column(String(64), primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())


class Connector(Base):
    """MCP servers added in Settings > Connectors."""
    __tablename__ = "connectors"

    id = Column(String(36), primary_key=True)
    name = Column(String(64), nullable=False, unique=True)
    kind = Column(String(16), nullable=False)          # "local" (command) or "remote" (URL)
    command = Column(Text, nullable=True)              # JSON list of strings (local)
    url = Column(Text, nullable=True)                  # remote
    secrets = Column(Text, nullable=True)              # encrypted {"env": {...}, "headers": {...}}
    catalog_id = Column(String(64), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    use_in_chat = Column(Boolean, nullable=False, default=True)
    use_in_code = Column(Boolean, nullable=False, default=True)
    created_at = Column(TIMESTAMP, default=func.current_timestamp())


class CodeProject(Base):
    """Folders opened on the Code page (the coding agent works in one of them)."""
    __tablename__ = "code_projects"

    id = Column(String(36), primary_key=True)
    # Real, absolute folder path. Paths can be long, so uniqueness is on a hash.
    path = Column(Text, nullable=False)
    path_hash = Column(String(64), nullable=False, unique=True)
    name = Column(String(255), nullable=False)
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    last_opened_at = Column(TIMESTAMP, default=func.current_timestamp())

    __table_args__ = (Index("idx_code_projects_last_opened", "last_opened_at"),)


class Memory(Base):
    """Saved memories: short facts about the user used in every chat (Settings >
    Personalization > Memory). See app/services/memory.py."""
    __tablename__ = "memories"

    id = Column(String(36), primary_key=True)
    text = Column(String(500), nullable=False)
    # The chat it was saved in (empty when added in Settings).
    thread_id = Column(String(191), nullable=True)
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())

    __table_args__ = (Index("idx_memories_created", "created_at"),)


class Project(Base):
    """Chat projects: a name, instructions and files shared by the project's
    chats (thread_metadata.project_id). See app/services/projects.py."""
    __tablename__ = "projects"

    id = Column(String(36), primary_key=True)
    name = Column(String(100), nullable=False)
    instructions = Column(Text, nullable=True)
    # Pinned projects are listed first in the sidebar.
    pinned = Column(Boolean, nullable=False, default=False, server_default="0")
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())


class AgentSession(Base):
    """Agent sessions: a task the agent works on in the background, with its
    status. Its conversation is a LangGraph checkpoint under the thread id
    "agent-<id>". See app/services/agent/."""
    __tablename__ = "agent_sessions"

    id = Column(String(36), primary_key=True)
    title = Column(String(200), nullable=False)
    task = Column(BigText, nullable=False)
    # queued, running, waiting, done, failed, stopped, interrupted, expired
    status = Column(String(20), nullable=False, default="queued")
    # The schedule that started it, if any (agent_schedules).
    schedule_id = Column(String(36), nullable=True)
    # What the agent is waiting for (JSON: a question or an approval), when waiting.
    waiting = Column(Text, nullable=True)
    result = Column(BigText, nullable=True)
    error = Column(String(500), nullable=True)
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())

    __table_args__ = (
        Index("idx_agent_sessions_updated", "updated_at"),
        Index("idx_agent_sessions_schedule", "schedule_id"),
    )


class AgentEvent(Base):
    """What happened in an agent session, in order: the plan, tool calls and
    results, messages, questions, approvals, status changes."""
    __tablename__ = "agent_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), nullable=False)
    seq = Column(Integer, nullable=False)
    type = Column(String(30), nullable=False)
    data = Column(BigText, nullable=True)  # JSON
    created_at = Column(TIMESTAMP, default=func.current_timestamp())

    __table_args__ = (Index("idx_agent_events_session", "session_id", "seq", unique=True),)


class AgentSchedule(Base):
    """Scheduled agent tasks: a task that starts an agent session at set times.
    See app/services/agent/schedules.py."""
    __tablename__ = "agent_schedules"

    id = Column(String(36), primary_key=True)
    title = Column(String(200), nullable=False)
    task = Column(BigText, nullable=False)
    # once | daily | weekly | cron
    repeat = Column(String(10), nullable=False)
    time = Column(String(5), nullable=True)        # HH:MM (once, daily, weekly)
    date = Column(String(10), nullable=True)       # YYYY-MM-DD (once)
    days = Column(String(20), nullable=True)       # weekly: "0,2,4" (Monday is 0)
    cron = Column(String(100), nullable=True)      # cron: "m h dom mon dow"
    timezone = Column(String(64), nullable=False, default="UTC")
    enabled = Column(Boolean, nullable=False, default=True, server_default="1")
    next_run_at = Column(TIMESTAMP, nullable=True)  # UTC
    last_run_at = Column(TIMESTAMP, nullable=True)  # UTC
    # started, skipped_busy, missed
    last_outcome = Column(String(20), nullable=True)
    created_at = Column(TIMESTAMP, default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, default=func.current_timestamp(), onupdate=func.current_timestamp())

    __table_args__ = (Index("idx_agent_schedules_next", "next_run_at"),)
