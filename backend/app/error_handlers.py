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


def public_error(ref: str, exc: BaseException = None) -> str:
    return f"{model_error_message(exc) or 'Something went wrong. Please try again.'} (ref {ref})"


# Known model-endpoint failures, matched on the error text (lowercase), and a
# fixed message for each. Only these fixed messages reach the browser.
_MODEL_ERRORS = [
    (("does not support tools", "tools param requires", "tool use is not supported",
      "tools are not supported", "does not support function calling", "--jinja"),
     "This model doesn't support tool calling, which chat needs. Choose a model that does in "
     "Settings > Developer (for llama.cpp, start llama-server with --jinja)."),
    (("context length", "context window", "maximum context", "context size", "too many tokens",
      "exceeds the available context"),
     "The conversation is longer than the model's context window. Start a new chat, or raise the "
     "model's context length (for Ollama, set OLLAMA_CONTEXT_LENGTH and restart it)."),
    (("model not found", "not found, try pulling", "no such model", "model_not_found"),
     "The model wasn't found at the provider. Check the model name in Settings > Developer; "
     "for a local server, download the model first."),
    (("connection refused", "connect error", "connection error", "failed to establish a new connection"),
     "Couldn't reach the model server. If it runs on this computer, start it and try again; "
     "Settings > Developer > Find local models shows what's running."),
]


def model_error_message(exc: BaseException = None):
    """A safe, specific message for a known model-endpoint failure, or None.
    Looks through the exception and the ones it was raised from."""
    seen = 0
    while exc is not None and seen < 10:
        text = f"{type(exc).__name__} {exc}".lower()
        for needles, message in _MODEL_ERRORS:
            if any(n in text for n in needles):
                return message
        if "apiconnectionerror" in text:
            return _MODEL_ERRORS[-1][1]
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return None


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
