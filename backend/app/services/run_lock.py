"""One reply at a time per chat thread.

Two requests on the same thread at once (a double send, or two tabs) would
both start from the same saved state and one turn would silently be lost.
The second request is refused with a clear message instead.
"""
import threading
from contextlib import contextmanager

from app.exceptions import ConflictError

_active: set[str] = set()
_guard = threading.Lock()

BUSY_MESSAGE = (
    "A reply is still being generated in this chat. "
    "Wait for it to finish, or press Stop, then try again."
)


@contextmanager
def exclusive_run(thread_id: str):
    """Hold the thread for the duration of a reply; raise ConflictError if busy."""
    with _guard:
        if thread_id in _active:
            raise ConflictError(BUSY_MESSAGE)
        _active.add(thread_id)
    try:
        yield
    finally:
        with _guard:
            _active.discard(thread_id)
