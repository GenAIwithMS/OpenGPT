"""Personalization: what the assistant knows about the user (Settings >
Personalization) and their custom instructions, as text for the model.

Used by the chat (added to the system prompt) and the coding agent (sent as
an instruction entry before each turn), so both follow the same profile.
"""
import logging

from app.services import settings as app_settings

logger = logging.getLogger(__name__)


def profile_text() -> str:
    """The profile as prompt text, or "" when nothing is set."""
    try:
        profile = app_settings.get_section("profile")
    except Exception as e:  # settings must never break a reply
        logger.warning("Could not read the profile: %s", e)
        return ""

    about = []
    if profile.nickname.strip():
        about.append(f"- Name: {profile.nickname.strip()}")
    if profile.occupation.strip():
        about.append(f"- Occupation: {profile.occupation.strip()}")
    if profile.about.strip():
        about.append(f"- More about them: {profile.about.strip()}")

    parts = []
    if about:
        parts.append(
            "About the user (from their settings; use it to tailor your replies, "
            "and don't repeat it back unless it's relevant):\n" + "\n".join(about)
        )
    if profile.instructions.strip():
        parts.append(
            "The user's custom instructions (follow them unless they conflict with "
            "safety or the current request):\n" + profile.instructions.strip()
        )
    return "\n\n".join(parts)
