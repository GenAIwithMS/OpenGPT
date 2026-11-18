"""Auto: pick a model for each message from the models set in Settings > Developer.

When the model menu next to the send button is on Auto (the default), each
message gets one of three models, chosen by a quick look at the message (no
extra model call):

    light   Titles and summaries model: greetings, thanks, very short messages
    normal  the Chat model (the Coding agent model on the Code page)
    strong  the Deep research model: long or code-heavy requests, analysis,
            debugging, design, step-by-step work, or a message about attached
            documents

When those roles all use the same model, Auto always picks that model. Picking
a model in the menu turns Auto off for that page.
"""
import re
from typing import Iterable, Optional

from app import llm

AUTO = "auto"

LONG_MESSAGE = 1500     # characters
SHORT_MESSAGE = 40

_STRONG_WORDS = re.compile(
    r"\b(analy[sz]e|analysis|architecture|prove|proof|derive|debug|refactor|optimi[sz]e|"
    r"design|trade-?offs?|step[- ]by[- ]step|algorithm|in[- ]depth|thorough|detailed|"
    r"strategy|evaluate|review|compare|comparison|plan|migrate|rewrite|implement)\b",
    re.I,
)
_LIGHT = re.compile(
    r"^\s*(hi|hey|hello|hy|yo|salam|assalam[\w ]*|good (morning|afternoon|evening|night)|"
    r"thanks?( you)?|thx|ty|ok(ay)?|cool|great|nice|bye|goodbye|yes|no|sure)\b[\s!.?,]*$",
    re.I,
)


def tier(message: str, *, has_document: bool = False, purpose: str = "chat") -> str:
    """'light', 'normal' or 'strong' for this message."""
    text = (message or "").strip()
    if "```" in text or len(text) > LONG_MESSAGE or (has_document and purpose == "chat"):
        return "strong"
    # Very short phrases ("plan my day") stay on the normal model.
    if len(text) > 25 and _STRONG_WORDS.search(text):
        return "strong"
    # Coding tasks never go to the light model: even a short request can mean real work.
    if purpose == "chat" and len(text) <= SHORT_MESSAGE and _LIGHT.match(text):
        return "light"
    return "normal"


def models_for(purpose: str = "chat") -> dict:
    """{'light', 'normal', 'strong'} model names for Auto."""
    cfg = llm.settings()
    return {
        "light": cfg["small_model"],
        "normal": cfg["coding_model"] if purpose == "code" else cfg["model"],
        "strong": cfg["research_model"],
    }


def choose(message: str, requested: Optional[str] = None, *, has_document: bool = False,
           purpose: str = "chat") -> tuple[str, bool]:
    """The model for this message and whether Auto picked it.

    ``requested`` is what the user picked in the menu: a model name, or empty /
    "auto" for Auto.
    """
    if requested and requested != AUTO:
        return requested, False
    return models_for(purpose)[tier(message, has_document=has_document, purpose=purpose)], True


def auto_summary(purpose: str = "chat") -> dict:
    """What Auto would use, for the menu: {'light', 'normal', 'strong'}."""
    return models_for(purpose)


def unique(names: Iterable[str]) -> list[str]:
    seen, out = set(), []
    for name in names:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out
