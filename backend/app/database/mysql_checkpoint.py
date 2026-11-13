import threading
import time
import weakref
from typing import Optional, Any, Iterator
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from langgraph.checkpoint.base import BaseCheckpointSaver, Checkpoint, CheckpointTuple
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from app.database.config import DatabaseConfig
from app.database.models import Checkpoint as CheckpointModel, CheckpointWrite as CheckpointWriteModel


# ---------------------------------------------------------------------------
# Concurrency control
# ---------------------------------------------------------------------------
# LangGraph can execute nodes in parallel (and the app can receive rapid
# concurrent requests on the same chat thread). The original implementation
# did an unsynchronized read-modify-write on the same checkpoint row, which
# produced Optimistic Concurrency Control collisions (MySQL "record has
# changed since last read" / duplicate-key on the checkpoint PK) and lost
# updates. We serialize every put/put_writes for a given thread_id so that
# only one writer touches that thread's rows at a time, and retry transient
# DB conflicts as a safety net.
# Weak values: a thread's lock is dropped once no request holds it, so the map
# doesn't grow by one entry for every thread id ever seen.
_thread_locks: "weakref.WeakValueDictionary[str, threading.RLock]" = weakref.WeakValueDictionary()
_thread_locks_guard = threading.Lock()

MAX_CONCURRENCY_RETRIES = 3


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------
# Values are stored with LangGraph's JsonPlusSerializer (msgpack), never with
# pickle: unpickling database content would let anyone who can write to the
# database run code in this process. Each blob is self-describing:
#   SERDE_MAGIC + <serde type> + b"\0" + <data>
SERDE_MAGIC = b"LGSERDE1:"
_serde = JsonPlusSerializer()  # pickle_fallback stays off


class LegacyCheckpointError(RuntimeError):
    """A stored value is in the old pickle format and must be migrated."""


def dumps(value: Any) -> bytes:
    type_, data = _serde.dumps_typed(value)
    return SERDE_MAGIC + type_.encode() + b"\0" + data


def loads(blob: Optional[bytes]) -> Any:
    if blob is None:
        return None
    if not blob.startswith(SERDE_MAGIC):
        raise LegacyCheckpointError(
            "Found a checkpoint in the old pickle format. It is not loaded, for "
            "security. Convert it once with: python -m scripts.migrate_checkpoints"
        )
    type_, _, data = blob[len(SERDE_MAGIC):].partition(b"\0")
    if type_ == b"pickle":
        raise LegacyCheckpointError("Refusing to load a pickled value")
    return _serde.loads_typed((type_.decode(), data))


def _lock_for(thread_id: str) -> threading.RLock:
    with _thread_locks_guard:
        lock = _thread_locks.get(thread_id)
        if lock is None:
            lock = threading.RLock()
            _thread_locks[thread_id] = lock
        return lock


class MySQLCheckpointSaver(BaseCheckpointSaver):
    """SQLAlchemy-based checkpoint saver for LangGraph"""

    def __init__(self):
        """Initialize MySQL checkpoint saver with SQLAlchemy"""
        super().__init__()
        self.session_factory = DatabaseConfig.get_session_factory()

    def _run(self, thread_id: str, fn):
        """Run fn(session) with a fresh session, serialized per thread and
        retried on transient DB conflicts."""
        lock = _lock_for(thread_id)
        last_exc = None
        for attempt in range(MAX_CONCURRENCY_RETRIES):
            session = self.session_factory()
            try:
                with lock:
                    result = fn(session)
                    session.commit()
                    return result
            except SQLAlchemyError as e:
                try:
                    session.rollback()
                except Exception:
                    pass
                last_exc = e
                # Briefly back off and retry the whole read-modify-write.
                time.sleep(0.05 * (attempt + 1))
                continue
            finally:
                session.close()
        raise last_exc

    def put(self, config: dict, checkpoint: Checkpoint, metadata: dict, new_versions: dict) -> dict:
        """Save a checkpoint to MySQL using SQLAlchemy"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = checkpoint["id"]
        parent_checkpoint_id = checkpoint.get("parent_id")

        def _op(session):
            checkpoint_blob = dumps(checkpoint)
            metadata_blob = dumps(metadata)

            existing = session.query(CheckpointModel).filter_by(
                thread_id=thread_id,
                checkpoint_ns=checkpoint_ns,
                checkpoint_id=checkpoint_id
            ).first()

            if existing:
                existing.parent_checkpoint_id = parent_checkpoint_id
                existing.type = checkpoint.get("type")
                existing.checkpoint = checkpoint_blob
                existing.meta = metadata_blob
            else:
                session.add(CheckpointModel(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns,
                    checkpoint_id=checkpoint_id,
                    parent_checkpoint_id=parent_checkpoint_id,
                    type=checkpoint.get("type"),
                    checkpoint=checkpoint_blob,
                    meta=metadata_blob
                ))

            return {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": checkpoint_id
                }
            }

        return self._run(thread_id, _op)

    def put_writes(self, config: dict, writes: list, task_id: str) -> None:
        """Save checkpoint writes to MySQL using SQLAlchemy"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = config["configurable"]["checkpoint_id"]

        def _op(session):
            # Ensure checkpoint exists before adding writes (to satisfy the
            # foreign key constraint). LangGraph may call put_writes before
            # put, so create a placeholder if needed.
            checkpoint_exists = session.query(CheckpointModel).filter_by(
                thread_id=thread_id,
                checkpoint_ns=checkpoint_ns,
                checkpoint_id=checkpoint_id
            ).first()

            if not checkpoint_exists:
                placeholder_checkpoint = {
                    "id": checkpoint_id,
                    "v": 1,
                    "ts": "",
                    "channel_values": {},
                    "channel_versions": {},
                    "versions_seen": {}
                }
                session.add(CheckpointModel(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns,
                    checkpoint_id=checkpoint_id,
                    parent_checkpoint_id=None,
                    type=None,
                    checkpoint=dumps(placeholder_checkpoint),
                    meta=dumps({})
                ))
                session.flush()

            # Use no_autoflush to prevent premature flush during queries.
            with session.no_autoflush:
                for idx, (channel, value) in enumerate(writes):
                    value_blob = dumps(value)

                    existing = session.query(CheckpointWriteModel).filter_by(
                        thread_id=thread_id,
                        checkpoint_ns=checkpoint_ns,
                        checkpoint_id=checkpoint_id,
                        task_id=task_id,
                        idx=idx
                    ).first()

                    if existing:
                        existing.type = type(value).__name__
                        existing.value = value_blob
                    else:
                        session.add(CheckpointWriteModel(
                            thread_id=thread_id,
                            checkpoint_ns=checkpoint_ns,
                            checkpoint_id=checkpoint_id,
                            task_id=task_id,
                            idx=idx,
                            channel=channel,
                            type=type(value).__name__,
                            value=value_blob
                        ))

        self._run(thread_id, _op)

    def get_tuple(self, config: dict) -> Optional[CheckpointTuple]:
        """Get a checkpoint tuple from MySQL using SQLAlchemy"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = config["configurable"].get("checkpoint_id")

        session = self.session_factory()
        try:
            if checkpoint_id:
                result = session.query(CheckpointModel).filter_by(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns,
                    checkpoint_id=checkpoint_id
                ).first()
            else:
                result = session.query(CheckpointModel).filter_by(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns
                ).order_by(CheckpointModel.checkpoint_id.desc()).first()

            if result:
                checkpoint = loads(result.checkpoint)
                metadata = loads(result.meta)
                config_with_id = {
                    "configurable": {
                        "thread_id": thread_id,
                        "checkpoint_ns": checkpoint_ns,
                        "checkpoint_id": checkpoint["id"] if not checkpoint_id else checkpoint_id
                    }
                }
                return CheckpointTuple(
                    config=config_with_id,
                    checkpoint=checkpoint,
                    metadata=metadata,
                    parent_config=None
                )
            return None
        finally:
            session.close()

    def get(self, config: dict) -> Optional[Checkpoint]:
        """Get a checkpoint from MySQL (convenience method)"""
        result = self.get_tuple(config)
        if result:
            return result[1]  # Return just the checkpoint
        return None

    def list(self, config: Optional[dict] = None) -> Iterator[CheckpointTuple]:
        """List all checkpoints, optionally filtered by config"""
        session = self.session_factory()
        try:
            query = session.query(CheckpointModel)

            if config and "thread_id" in config.get("configurable", {}):
                thread_id = config["configurable"]["thread_id"]
                checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
                query = query.filter_by(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns
                ).order_by(CheckpointModel.checkpoint_id.desc())
            else:
                query = query.order_by(
                    CheckpointModel.thread_id,
                    CheckpointModel.checkpoint_id.desc()
                )

            for result in query:
                checkpoint = loads(result.checkpoint)
                metadata = loads(result.meta)
                config_dict = {
                    "configurable": {
                        "thread_id": result.thread_id,
                        "checkpoint_ns": result.checkpoint_ns,
                        "checkpoint_id": result.checkpoint_id
                    }
                }
                yield CheckpointTuple(
                    config=config_dict,
                    checkpoint=checkpoint,
                    metadata=metadata,
                    parent_config=None
                )
        finally:
            session.close()
