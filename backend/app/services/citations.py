"""Turn the model's ``【n†source】`` citation markers into markdown links.

gpt-oss cites search results with opaque markers such as ``【1†source】`` or
``【Source 2†https://...】``. The chat UI cannot render those, so once an answer
is complete the markers are resolved against the search results the model saw
and rewritten as ``[Site](url "Page title (YYYY-MM-DD)")``. The link *title*
carries the page title and date so the frontend can show them in a hover card;
in any other markdown renderer it is just a normal link.
"""
import re
from typing import Dict, Optional
from urllib.parse import urlparse

# ``--- SOURCE n: title ---`` blocks as produced by app.tools.parallel_search.format_results
_SOURCE_RE = re.compile(
    r"^--- SOURCE (\d+): (.*?) ---\nURL: (\S+)(?:\nPublished: (\S+))?", re.M
)
_MARKER_RE = re.compile(r"【([^】]*)】")
_URL_RE = re.compile(r"https?://[^\s】]+")
_TITLE_SPLIT_RE = re.compile(r"\s+(?:[|\-–—]|::)\s+")


def extract_sources(tool_output: str) -> Dict[int, dict]:
    """Map source number -> {url, title, date} for one search result blob."""
    sources = {}
    for num, title, url, date in _SOURCE_RE.findall(tool_output or ""):
        sources[int(num)] = {"url": url, "title": title.strip(), "date": date or ""}
    return sources


def site_label(title: str, url: str) -> str:
    """Short publisher name for a chip, e.g. "BBC Sport" or "pcb.com.pk".

    Page titles usually end with the site name ("... | BBC Sport"); fall back
    to the host name when the title has no such suffix.
    """
    parts = [p.strip() for p in _TITLE_SPLIT_RE.split(title or "") if p.strip()]
    if len(parts) >= 2 and len(parts[-1]) <= 40:
        return parts[-1]
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def _link(source: dict) -> str:
    url = source["url"]
    label = site_label(source.get("title", ""), url).replace("]", ")")
    title = (source.get("title") or label).replace('"', "'")
    if source.get("date"):
        title = f"{title} ({source['date']})"
    return f"[{label}]({url} \"{title}\")"


def _resolve(marker: str, sources: Dict[int, dict]) -> Optional[dict]:
    url_match = _URL_RE.search(marker)
    if url_match:
        url = url_match.group(0).rstrip(".,;)")
        for src in sources.values():
            if src["url"] == url:
                return src
        return {"url": url, "title": "", "date": ""}
    num_match = re.search(r"\d+", marker)
    if num_match:
        return sources.get(int(num_match.group(0)))
    return None


def link_citations(text: str, sources: Dict[int, dict]) -> str:
    """Replace citation markers with markdown links; drop ones that can't be resolved."""
    if "【" not in text:
        return text

    def repl(match):
        src = _resolve(match.group(1), sources)
        start, end = match.span()
        glued = start > 0 and not text[start - 1].isspace()
        if not src:
            # Dropping a marker must not fuse the words around it
            return " " if glued and end < len(text) and text[end].isalnum() else ""
        return (" " if glued else "") + _link(src)

    linked = _MARKER_RE.sub(repl, text)
    # Markers glued to the following word ("…】The") need a space after the link
    return re.sub(r'"\)(?=[^\s.,;:!?)\]])', '") ', linked)
