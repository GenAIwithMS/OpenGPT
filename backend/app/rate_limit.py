"""Simple in-memory rate limiting for the expensive routes.

Every chat, edit, regenerate, upload or document query costs paid LLM and
search calls, so each client gets a limited number per minute.
Set RATE_LIMIT_PER_MINUTE (default 20; 0 turns the limit off).
"""
import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Request

from app.exceptions import RateLimitError

WINDOW_SECONDS = 60


class SlidingWindowLimiter:
    def __init__(self, limit: int, window: float = WINDOW_SECONDS):
        self.limit = limit
        self.window = window
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        if self.limit <= 0:
            return
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                retry = int(self.window - (now - hits[0])) + 1
                raise RateLimitError(
                    f"Too many requests. Please wait {retry} seconds and try again.",
                    details={"retry_after": retry},
                )
            hits.append(now)
            # Forget idle clients so the map doesn't grow forever.
            if len(self._hits) > 10_000:
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                    del self._hits[k]


limiter = SlidingWindowLimiter(int(os.getenv("RATE_LIMIT_PER_MINUTE", "20")))


def rate_limit(request: Request) -> None:
    """FastAPI dependency: limit expensive calls per client address."""
    client = request.client.host if request.client else "unknown"
    limiter.check(client)
