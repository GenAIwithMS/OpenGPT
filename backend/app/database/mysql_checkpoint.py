"""MySQL checkpoint saver for LangGraph (SQLAlchemy based)."""
import asyncio
import os
import threading
import time
import weakref
from typing import Any, AsyncIterator, Iterator, List, Optional, Sequence

from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    BaseCheckpointSaver,
    Checkpoint,
    CheckpointTuple,
    get_checkpoint_metadata,
)
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, OperationalError

from app.database.config import DatabaseConfig
from app.database.models import Checkpoint as CheckpointModel
from app.database.models import CheckpointWrite as CheckpointWriteModel


# ---------------------------------------------------------------------------
# Concurrency control
# ---------------------------------------------------------------------------
# LangGraph can run nodes in parallel, and the app can get concurrent requests
# on one thread. Every write for a thread is serialized with a per-thread lock,
# and transient MySQL conflicts are retried.
# Weak values: a thread's lock is dropped once no request holds it, so the map
# doesn't grow by one entry for every thread id ever seen.
_thread_locks: "weakref.WeakValueDictionary[str, threading.RLock]" = weakref.WeakValueDictionary()
_thread_locks_guard = threading.Lock()

MAX_CONCURRENCY_RETRIES = 3

# MySQL errors worth retrying: lock wait timeout, deadlock, and a duplicate key
# from two writers racing to insert the same row. Anything else (e.g. "data too
# long") fails immediately instead of being retried pointlessly.
_TRANSIENT_MYSQL_ERRORS = {1205, 1213, 1062}

# Only the latest checkpoints of a thread are ever read (the app has no "time
# travel"), so older ones are deleted. Without this, every step keeps a full
# copy of the conversation and storage grows quadratically with thread length.
# 0 keeps everything.
MAX_CHECKPOINTS_PER_THREAD = int(os.getenv("MAX_CHECKPOINTS_PER_THREAD", "20"))


def _is_transient(exc: Exception) -> bool:
    if not isinstance(exc, (OperationalError, IntegrityError)):
        return False
    code = getattr(getattr(exc, "orig", None), "args", [None])[0]
    return code in _TRANSIENT_MYSQL_ERRORS


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


def _config(thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> dict:
    return {
        "configurable": {
            "thread_id": thread_id,
            "checkpoint_ns": checkpoint_ns,
            "checkpoint_id": checkpoint_id,
        }
    }


class MySQLCheckpointSaver(BaseCheckpointSaver):
    """SQLAlchemy-based checkpoint saver for LangGraph."""

    def __init__(self):
        super().__init__()
        self.session_factory = DatabaseConfig.get_session_factory()

    # -- helpers ------------------------------------------------------------

    def _run(self, thread_id: str, fn):
        """Run fn(session) in a transaction, serialized per thread and retried
        on transient DB conflicts."""
        lock = _lock_for(thread_id)
        for attempt in range(MAX_CONCURRENCY_RETRIES):
            session = self.session_factory()
            try:
                with lock:
                    result = fn(session)
                    session.commit()
                    return result
            except (OperationalError, IntegrityError) as e:
                session.rollback()
                if not _is_transient(e) or attempt == MAX_CONCURRENCY_RETRIES - 1:
                    raise
                time.sleep(0.05 * (attempt + 1))
            except Exception:
                session.rollback()
                raise
            finally:
                session.close()

    def _pending_writes(self, session, thread_id: str, checkpoint_ns: str, checkpoint_id: str) -> list:
        rows = (
            session.query(CheckpointWriteModel)
            .filter_by(thread_id=thread_id, checkpoint_ns=checkpoint_ns, checkpoint_id=checkpoint_id)
            .order_by(CheckpointWriteModel.task_id, CheckpointWriteModel.idx)
            .all()
        )
        return [(row.task_id, row.channel, loads(row.value)) for row in rows]

    def _to_tuple(self, session, row: CheckpointModel) -> CheckpointTuple:
        parent = (
            _config(row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id)
            if row.parent_checkpoint_id
            else None
        )
        return CheckpointTuple(
            config=_config(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
            checkpoint=loads(row.checkpoint),
            metadata=loads(row.meta),
            parent_config=parent,
            pending_writes=self._pending_writes(
                session, row.thread_id, row.checkpoint_ns, row.checkpoint_id
            ),
        )

    def _prune(self, session, thread_id: str, checkpoint_ns: str) -> None:
        """Delete all but the newest MAX_CHECKPOINTS_PER_THREAD checkpoints."""
        if MAX_CHECKPOINTS_PER_THREAD <= 0:
            return
        cutoff = (
            session.query(CheckpointModel.checkpoint_id)
            .filter_by(thread_id=thread_id, checkpoint_ns=checkpoint_ns)
            .order_by(CheckpointModel.checkpoint_id.desc())
            .offset(MAX_CHECKPOINTS_PER_THREAD - 1)
            .limit(1)
            .scalar()
        )
        if cutoff is None:
            return
        for model in (CheckpointWriteModel, CheckpointModel):
            session.query(model).filter(
                model.thread_id == thread_id,
                model.checkpoint_ns == checkpoint_ns,
                model.checkpoint_id < cutoff,
            ).delete(synchronize_session=False)

    # -- sync API -----------------------------------------------------------

    def put(self, config: dict, checkpoint: Checkpoint, metadata: dict, new_versions: dict) -> dict:
        """Save a checkpoint.

        The parent is the checkpoint the caller's config points at. Older
        checkpoints beyond MAX_CHECKPOINTS_PER_THREAD are pruned.
        """
        configurable = config["configurable"]
        thread_id = configurable["thread_id"]
        checkpoint_ns = configurable.get("checkpoint_ns", "")
        checkpoint_id = checkpoint["id"]
        parent_checkpoint_id = configurable.get("checkpoint_id")
        checkpoint_blob = dumps(checkpoint)
        metadata_blob = dumps(get_checkpoint_metadata(config, metadata))

        def _op(session):
            existing = session.query(CheckpointModel).filter_by(
                thread_id=thread_id, checkpoint_ns=checkpoint_ns, checkpoint_id=checkpoint_id
            ).first()
            if existing:
                existing.parent_checkpoint_id = parent_checkpoint_id
                existing.checkpoint = checkpoint_blob
                existing.meta = metadata_blob
            else:
                session.add(CheckpointModel(
                    thread_id=thread_id,
                    checkpoint_ns=checkpoint_ns,
                    checkpoint_id=checkpoint_id,
                    parent_checkpoint_id=parent_checkpoint_id,
                    type=None,
                    checkpoint=checkpoint_blob,
                    meta=metadata_blob,
                ))
            session.flush()
            self._prune(session, thread_id, checkpoint_ns)
            return _config(thread_id, checkpoint_ns, checkpoint_id)

        return self._run(thread_id, _op)

    def put_writes(self, config: dict, writes: Sequence[tuple], task_id: str, task_path: str = "") -> None:
        """Save intermediate writes for a checkpoint.

        Same rules as LangGraph's in-memory saver: special channels (errors,
        interrupts, ...) use a fixed index and are overwritten; regular writes
        are only inserted once and never overwrite an earlier write.
        """
        configurable = config["configurable"]
        thread_id = configurable["thread_id"]
        checkpoint_ns = configurable.get("checkpoint_ns", "")
        checkpoint_id = configurable["checkpoint_id"]
        overwrite = all(channel in WRITES_IDX_MAP for channel, _ in writes)
        rows = [
            (WRITES_IDX_MAP.get(channel, idx), channel, dumps(value))
            for idx, (channel, value) in enumerate(writes)
        ]

        def _op(session):
            with session.no_autoflush:
                for idx, channel, value_blob in rows:
                    existing = session.query(CheckpointWriteModel).filter_by(
                        thread_id=thread_id,
                        checkpoint_ns=checkpoint_ns,
                        checkpoint_id=checkpoint_id,
                        task_id=task_id,
                        idx=idx,
                    ).first()
                    if existing is None:
                        session.add(CheckpointWriteModel(
                            thread_id=thread_id,
                            checkpoint_ns=checkpoint_ns,
                            checkpoint_id=checkpoint_id,
                            task_id=task_id,
                            idx=idx,
                            channel=channel,
                            type=None,
                            value=value_blob,
                        ))
                    elif overwrite:
                        existing.channel = channel
                        existing.value = value_blob

        self._run(thread_id, _op)

    def get_tuple(self, config: dict) -> Optional[CheckpointTuple]:
        """Get one checkpoint: the one in config, or the thread's latest."""
        configurable = config["configurable"]
        thread_id = configurable["thread_id"]
        checkpoint_ns = configurable.get("checkpoint_ns", "")
        checkpoint_id = configurable.get("checkpoint_id")

        session = self.session_factory()
        try:
            query = session.query(CheckpointModel).filter_by(
                thread_id=thread_id, checkpoint_ns=checkpoint_ns
            )
            if checkpoint_id:
                row = query.filter_by(checkpoint_id=checkpoint_id).first()
            else:
                row = query.order_by(CheckpointModel.checkpoint_id.desc()).first()
            return self._to_tuple(session, row) if row else None
        finally:
            session.close()

    def list(
        self,
        config: Optional[dict],
        *,
        filter: Optional[dict] = None,
        before: Optional[dict] = None,
        limit: Optional[int] = None,
    ) -> Iterator[CheckpointTuple]:
        """List checkpoints, newest first.

        Args:
            config: limit to this thread (and namespace / checkpoint id, if given).
            filter: only checkpoints whose metadata contains these key/values.
            before: only checkpoints older than this config's checkpoint id.
            limit: maximum number of checkpoints to return.
        """
        session = self.session_factory()
        try:
            query = session.query(CheckpointModel)
            configurable = (config or {}).get("configurable", {})
            if "thread_id" in configurable:
                query = query.filter(CheckpointModel.thread_id == configurable["thread_id"])
            if configurable.get("checkpoint_ns") is not None:
                query = query.filter(CheckpointModel.checkpoint_ns == configurable["checkpoint_ns"])
            if configurable.get("checkpoint_id"):
                query = query.filter(CheckpointModel.checkpoint_id == configurable["checkpoint_id"])
            before_id = (before or {}).get("configurable", {}).get("checkpoint_id")
            if before_id:
                query = query.filter(CheckpointModel.checkpoint_id < before_id)
            query = query.order_by(CheckpointModel.thread_id, CheckpointModel.checkpoint_id.desc())

            returned = 0
            for row in query.all():
                if limit is not None and returned >= limit:
                    break
                if filter:
                    metadata = loads(row.meta) or {}
                    if any(metadata.get(k) != v for k, v in filter.items()):
                        continue
                yield self._to_tuple(session, row)
                returned += 1
        finally:
            session.close()

    def delete_thread(self, thread_id: str) -> None:
        """Delete every checkpoint and write of a thread."""

        def _op(session):
            for model in (CheckpointWriteModel, CheckpointModel):
                session.query(model).filter_by(thread_id=thread_id).delete(synchronize_session=False)

        self._run(thread_id, _op)

    def list_thread_ids(self) -> List[str]:
        """Thread ids that have checkpoints, most recently active first.

        Reads only ids, so listing threads doesn't load every checkpoint.
        """
        session = self.session_factory()
        try:
            rows = (
                session.query(CheckpointModel.thread_id, func.max(CheckpointModel.checkpoint_id))
                .group_by(CheckpointModel.thread_id)
                .order_by(func.max(CheckpointModel.checkpoint_id).desc())
                .all()
            )
            return [thread_id for thread_id, _ in rows]
        finally:
            session.close()

    # -- async API ----------------------------------------------------------
    # The database driver is synchronous, so the async methods run the sync
    # ones in a worker thread. This lets graphs use ainvoke / astream.

    async def aget_tuple(self, config: dict) -> Optional[CheckpointTuple]:
        return await asyncio.to_thread(self.get_tuple, config)

    async def alist(
        self,
        config: Optional[dict],
        *,
        filter: Optional[dict] = None,
        before: Optional[dict] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[CheckpointTuple]:
        items = await asyncio.to_thread(
            lambda: list(self.list(config, filter=filter, before=before, limit=limit))
        )
        for item in items:
            yield item

    async def aput(self, config: dict, checkpoint: Checkpoint, metadata: dict, new_versions: dict) -> dict:
        return await asyncio.to_thread(self.put, config, checkpoint, metadata, new_versions)

    async def aput_writes(self, config: dict, writes: Sequence[tuple], task_id: str, task_path: str = "") -> None:
        await asyncio.to_thread(self.put_writes, config, writes, task_id, task_path)

    async def adelete_thread(self, thread_id: str) -> None:
        await asyncio.to_thread(self.delete_thread, thread_id)
