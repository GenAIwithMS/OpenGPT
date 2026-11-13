import os

import uvicorn
from app import create_app

app = create_app()

if __name__ == "__main__":
    # Local-only and no auto-reload by default. Set HOST=0.0.0.0 to expose the
    # API on your network, and RELOAD=true while developing.
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "false").lower() == "true",
    )
