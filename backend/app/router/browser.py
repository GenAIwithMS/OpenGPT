"""Browser routes (/api/browser): whether the browser works here, site permissions, saved website tools."""
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.services import browser_engine
from app.services.agent import browser

browser_router = APIRouter()


class Options(BaseModel):
    show_window: bool


class Site(BaseModel):
    url: str = Field(..., max_length=2048)
    access: Literal["read", "write"]


@browser_router.get("/browser/status")
def status():
    """{available, reason}: reason says what is missing (Node.js 24, a built engine)."""
    reason = browser_engine.unavailable_reason(refresh=True)
    return {"available": reason is None, "reason": reason}


@browser_router.get("/browser/options")
def get_options():
    """{show_window}: open the browser in a window on this computer while it works."""
    return browser.get_options()


@browser_router.put("/browser/options")
def set_options(body: Options):
    return browser.set_options(body.show_window)


@browser_router.get("/browser/sites")
def list_sites():
    """Websites the agent may use: {origin: "read" | "write"}."""
    return {"sites": browser.list_sites()}


@browser_router.put("/browser/sites")
def set_site(body: Site):
    return {"sites": browser.set_site(body.url, body.access)}


@browser_router.delete("/browser/sites")
def remove_site(url: str = Query(..., max_length=2048)):
    return {"sites": browser.remove_site(url)}


@browser_router.get("/browser/tools")
def list_tools():
    """Website tools the agent built, which run again with no model."""
    return {"tools": browser.saved_tools()}


@browser_router.delete("/browser/tools/{name}", status_code=204)
def delete_tool(name: str):
    browser.delete_tool(name)
