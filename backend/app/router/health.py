from fastapi import APIRouter, Request

health_router = APIRouter()


@health_router.get("/")
def root(request: Request):
    info = {"message": "OpenGPT API", "version": "1.0.0"}
    # Only advertise the docs when they are switched on.
    if request.app.docs_url:
        info["docs"] = request.app.docs_url
    return info


@health_router.get("/health")
def health():
    return {"status": "ok"}
