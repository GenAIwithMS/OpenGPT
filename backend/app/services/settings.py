"""App settings (the Settings popup): stored per section in `app_settings`.

There is no login yet, so these are the settings of this OpenGPT install.
Every section is validated by a schema; unknown fields are refused, so the
table only ever holds known, size-limited values.

Sections:
    profile   nickname, occupation, about, instructions (Personalization)
    general   temporary_by_default, notify_on_finish, sound_on_finish
"""
import json
import logging

from pydantic import BaseModel, ConfigDict, Field, ValidationError as PydanticValidationError

from app.database.config import DatabaseConfig
from app.database.models import AppSetting
from app.exceptions import ValidationError

logger = logging.getLogger(__name__)

DEFAULT_NAME = "Muhammad"


class _Section(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProfileSettings(_Section):
    nickname: str = Field("", max_length=50)
    occupation: str = Field("", max_length=100)
    about: str = Field("", max_length=2000)
    instructions: str = Field("", max_length=4000)


class GeneralSettings(_Section):
    temporary_by_default: bool = False
    notify_on_finish: bool = False
    sound_on_finish: bool = False


SECTIONS: dict[str, type[_Section]] = {
    "profile": ProfileSettings,
    "general": GeneralSettings,
}


def _session():
    return DatabaseConfig.get_session_factory()()


def _stored(db, key: str) -> dict:
    row = db.get(AppSetting, key)
    if row is None:
        return {}
    try:
        value = json.loads(row.value)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        logger.warning("Ignoring unreadable settings section %s", key)
        return {}


def _load(db, key: str) -> _Section:
    schema = SECTIONS[key]
    stored = _stored(db, key)
    try:
        return schema(**stored)
    except PydanticValidationError:
        # A field from an older version: keep what still fits.
        known = {k: v for k, v in stored.items() if k in schema.model_fields}
        try:
            return schema(**known)
        except PydanticValidationError:
            return schema()


def get_all() -> dict:
    with _session() as db:
        values = {key: _load(db, key).model_dump() for key in SECTIONS}
    values["display_name"] = values["profile"]["nickname"].strip() or DEFAULT_NAME
    return values


def get_section(key: str) -> _Section:
    with _session() as db:
        return _load(db, key)


def update(changes: dict) -> dict:
    """Merge partial changes into their sections. Returns all settings."""
    if not isinstance(changes, dict) or not changes:
        raise ValidationError("Nothing to save")
    unknown = [k for k in changes if k not in SECTIONS]
    if unknown:
        raise ValidationError(f"Unknown settings: {', '.join(sorted(unknown))}")
    with _session() as db:
        for key, partial in changes.items():
            if not isinstance(partial, dict):
                raise ValidationError(f"Settings for {key} must be an object")
            merged = {**_load(db, key).model_dump(), **partial}
            try:
                value = SECTIONS[key](**merged)
            except PydanticValidationError as e:
                first = e.errors()[0]
                field = ".".join(str(p) for p in first.get("loc", ()))
                raise ValidationError(f"{key}.{field}: {first.get('msg')}") from None
            row = db.get(AppSetting, key)
            text = value.model_dump_json()
            if row is None:
                db.add(AppSetting(key=key, value=text))
            else:
                row.value = text
        db.commit()
    return get_all()
