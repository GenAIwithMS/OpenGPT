import os

import uvicorn
from app import create_app
from app.security import check_exposure

app = create_app()

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    check_exposure(host)
    # Local-only and no auto-reload by default. Set HOST=0.0.0.0 to expose the
    # API on your network, and RELOAD=true while developing.
    # BIND_HOST: the address to listen on when it differs from HOST. The Docker
    # image listens on 0.0.0.0 inside the container while HOST stays local,
    # because the container's port is published on 127.0.0.1 only.
    uvicorn.run(
        "main:app",
        host=os.getenv("BIND_HOST") or host,
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "false").lower() == "true",
    )
