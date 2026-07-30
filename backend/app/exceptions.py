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
    status_code = 403
    code = "UNAUTHORIZED"


class RateLimitError(AppError):
    status_code = 429
    code = "RATE_LIMIT"
