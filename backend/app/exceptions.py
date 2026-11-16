"""Custom exception classes for the application.

Usage:
    from app.exceptions import NotFoundError, ValidationError
    raise NotFoundError("Submission not found")
"""


class AppError(Exception):
    status_code: int = 500
    code: str = "INTERNAL_ERROR"

    def __init__(self, message: str = "", details: dict | None = None):
        self.message = message
        self.details = details or {}


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"


class ValidationError(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"


class UnauthorizedError(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


class ConflictError(AppError):
    status_code = 409
    code = "CONFLICT"


class RateLimitError(AppError):
    status_code = 429
    code = "RATE_LIMIT"


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "SERVICE_UNAVAILABLE"


class UpstreamError(AppError):
    """A service the backend depends on (e.g. the coding agent) failed."""

    status_code = 502
    code = "UPSTREAM_ERROR"
