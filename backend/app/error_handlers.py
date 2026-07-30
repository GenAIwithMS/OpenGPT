import logging
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from app.exceptions import AppError

logger = logging.getLogger(__name__)


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
