"""Connector routes (/api/connectors): MCP servers for chat and the coding agent."""
import logging
import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.error_handlers import log_error
from app.exceptions import AppError
from app.rate_limit import rate_limit
from app.services import connector_oauth, connectors
from app.services.coding_agent import stream as coding_stream
from app.services.coding_agent.process import agent

logger = logging.getLogger(__name__)

connectors_router = APIRouter(prefix="/connectors")


def refresh_loop(stop: threading.Event, every_seconds: int = 300) -> None:
    """Keep connector sign-ins fresh. The coding agent gets new tokens by
    restarting, which is done only while no coding task is running."""
    pending_restart = False
    while not stop.wait(every_seconds):
        try:
            pending_restart = connectors.refresh_due() > 0 or pending_restart
            if pending_restart and not coding_stream._running:
                agent.restart()
                pending_restart = False
        except Exception as e:
            logger.warning("Connector token refresh failed: %s", e)


class ConnectorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=48)
    kind: str = Field(..., pattern="^(local|remote)$")
    command: Optional[Any] = Field(None, description="Program and arguments (list or one string)")
    url: Optional[str] = Field(None, max_length=2000)
    env: Optional[Dict[str, str]] = None
    headers: Optional[Dict[str, str]] = None


class CatalogAdd(BaseModel):
    values: Dict[str, str] = Field(default_factory=dict, description="Required keys/tokens by name")


class ImportRequest(BaseModel):
    json_text: str = Field(..., min_length=2, max_length=50_000, alias="json")


def _apply_to_agent() -> bool:
    """Restart the coding agent in the background so it picks up the change."""
    threading.Thread(target=agent.restart, daemon=True).start()
    return True


@connectors_router.get("")
def list_connectors():
    return {"connectors": connectors.list_connectors()}


@connectors_router.get("/catalog")
def catalog():
    return {"catalog": connectors.catalog()}


@connectors_router.post("", status_code=201, dependencies=[Depends(rate_limit)])
def create_connector(request: ConnectorCreate):
    """Add a custom MCP server (a local command, or a URL)."""
    result = connectors.create(**request.model_dump())
    _apply_to_agent()
    return result


@connectors_router.post("/catalog/{catalog_id}", status_code=201, dependencies=[Depends(rate_limit)])
def add_from_catalog(catalog_id: str, request: CatalogAdd = Body(default_factory=CatalogAdd)):
    result = connectors.add_from_catalog(catalog_id, request.values)
    _apply_to_agent()
    return result


@connectors_router.post("/import", status_code=201, dependencies=[Depends(rate_limit)])
def import_json(request: ImportRequest):
    """Add servers from an MCP JSON config ({"mcpServers": {...}})."""
    result = {"connectors": connectors.import_json(request.json_text)}
    _apply_to_agent()
    return result


class SignInStart(BaseModel):
    catalog_id: Optional[str] = Field(None, max_length=64)
    name: Optional[str] = Field(None, max_length=48)
    url: Optional[str] = Field(None, max_length=2000)
    connector_id: Optional[str] = Field(None, max_length=64)


@connectors_router.post("/oauth/start", dependencies=[Depends(rate_limit)])
def start_sign_in(request: SignInStart):
    """The provider's sign-in page to open (catalog entry, custom URL, or sign in again)."""
    return {"authorize_url": connectors.start_sign_in(**request.model_dump()),
            "redirect_uri": connector_oauth.redirect_uri()}


# The provider sends the browser here after sign-in. It can't carry the API
# token (it's a redirect), so it is not behind it: the single-use `state`
# from /oauth/start is what ties it to a sign-in OpenGPT started.
connectors_callback_router = APIRouter(prefix="/connectors")


@connectors_callback_router.get("/oauth/callback", response_class=HTMLResponse, include_in_schema=False)
def sign_in_callback(state: str = "", code: str = "", error: str = "", error_description: str = ""):
    if error:
        logger.info("Connector sign-in was not completed: %s", error)
        return HTMLResponse(connector_oauth.callback_page(False, "Sign-in was cancelled or refused."), status_code=400)
    try:
        info = connectors.finish_sign_in(state, code)
    except AppError as e:
        return HTMLResponse(connector_oauth.callback_page(False, e.message), status_code=400)
    except Exception as e:
        ref = log_error("Connector sign-in failed", e)
        return HTMLResponse(connector_oauth.callback_page(False, f"Couldn't connect. (ref {ref})"), status_code=500)
    _apply_to_agent()
    return HTMLResponse(connector_oauth.callback_page(True, f"{info['title']} is connected."))


@connectors_router.put("/{connector_id}")
def update_connector(connector_id: str, changes: Dict[str, Any] = Body(...)):
    """Turn a connector on/off, choose chat/code, or replace its secrets."""
    result = connectors.update(connector_id, changes)
    _apply_to_agent()
    return result


@connectors_router.delete("/{connector_id}", status_code=204)
def delete_connector(connector_id: str):
    connectors.delete(connector_id)
    _apply_to_agent()
