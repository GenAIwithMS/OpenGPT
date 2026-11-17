"""Model providers: /api/providers (Settings > Developer). See app/services/providers.py."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.rate_limit import rate_limit
from app.services import providers

providers_router = APIRouter(prefix="/providers")


class ProviderCreate(BaseModel):
    preset: str = Field(..., max_length=32)
    name: str = Field("", max_length=60)
    kind: Optional[str] = Field(None, max_length=16)
    base_url: str = Field("", max_length=500)
    api_key: str = Field("", max_length=1000)
    model: str = Field("", max_length=200)


class ProviderUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    base_url: Optional[str] = Field(None, max_length=500)
    api_key: Optional[str] = Field(None, max_length=1000)
    model: Optional[str] = Field(None, max_length=200)
    clear_key: bool = False


class ProviderTest(BaseModel):
    provider_id: Optional[str] = Field(None, max_length=32)
    preset: Optional[str] = Field(None, max_length=32)
    kind: str = Field("openai", max_length=16)
    base_url: str = Field("", max_length=500)
    api_key: str = Field("", max_length=1000)


class ActiveChoice(BaseModel):
    active: str = Field(..., max_length=32)
    roles: dict[str, str] = Field(default_factory=dict)


@providers_router.get("")
def overview():
    return providers.overview()


@providers_router.get("/models")
def models():
    """The model menu: {models, chat_default, code_default, auto: {chat, code}}."""
    from app import llm
    from app.services import model_router

    cfg = llm.settings()
    return {
        "models": providers.available_models(),
        "chat_default": cfg["model"],
        "code_default": cfg["coding_model"],
        "auto": {"chat": model_router.auto_summary("chat"), "code": model_router.auto_summary("code")},
    }


@providers_router.post("", status_code=201, dependencies=[Depends(rate_limit)])
def create(request: ProviderCreate):
    return providers.create(**request.model_dump())


@providers_router.post("/test", dependencies=[Depends(rate_limit)])
def test(request: ProviderTest):
    return providers.test(**request.model_dump())


@providers_router.put("/active")
def set_active(request: ActiveChoice):
    return providers.set_active(request.active, request.roles)


@providers_router.put("/{provider_id}")
def update(provider_id: str, request: ProviderUpdate):
    return providers.update(provider_id[:32], request.model_dump(exclude_none=True))


@providers_router.delete("/{provider_id}", status_code=204)
def delete(provider_id: str):
    providers.delete(provider_id[:32])
