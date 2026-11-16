"""Settings routes (/api/settings)."""
from typing import Any, Dict

from fastapi import APIRouter, Body

from app.services import settings as app_settings

settings_router = APIRouter(prefix="/settings")


@settings_router.get("")
def get_settings():
    """All settings, with defaults filled in, plus the display name."""
    return app_settings.get_all()


@settings_router.put("")
def update_settings(changes: Dict[str, Dict[str, Any]] = Body(...)):
    """Save some settings, e.g. {"general": {"send_key": "ctrl_enter"}}."""
    return app_settings.update(changes)
