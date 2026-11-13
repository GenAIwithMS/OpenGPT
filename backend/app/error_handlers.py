import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from app.exceptions import AppError

logger = logging.getLogger(__name__)


def log_error(context: str, exc: BaseException) -> str:
    """Log an exception with its traceback and return a short reference code.

    Clients only ever see the reference code, never the exception text, which
    can contain SQL, file paths, provider responses or API keys.
    """
    ref = uuid.uuid4().hex[:8]
    logger.error("%s [ref %s]: %s", context, ref, exc, exc_info=exc)
    return ref


def public_error(ref: str) -> str:
    return f"Something went wrong. Please try again. (ref {ref})"


def _build_response(error: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {
                "code": error.code,
                "message": error.message,
                "details": error.details,
            }
        },
    )


def register_error_handlers(app: FastAPI) -> None:

    @app.exception_handler(AppError)
    async def handle_app_error(_req: Request, exc: AppError):
        logger.warning("AppError: %s — %s", exc.code, exc.message)
        return _build_response(exc)

    @app.exception_handler(Exception)
    async def handle_unhandled(_req: Request, exc: Exception):
        logger.exception("Unhandled exception: %s", exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "An unexpected error occurred",
                    "details": {},
                }
            },
        )
