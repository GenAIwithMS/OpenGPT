"""Turn the model's ``【n†source】`` citation markers into markdown links.

Some models cite search results with opaque markers such as ``【1†source】`` or
``【Source 2†https://...】``. The chat UI cannot render those, so once an answer
is complete the markers are resolved against the search results the model saw
and rewritten as ``[Site](url "Page title (YYYY-MM-DD)")``. The link *title*
carries the page title and date so the frontend can show them in a hover card;
in any other markdown renderer it is just a normal link.
"""
import re
from typing import Dict, List, Optional
from urllib.parse import urlparse

# ``--- SOURCE n: title ---`` blocks as produced by app.tools.parallel_search.format_results
_SOURCE_RE = re.compile(
    r"^--- SOURCE (\d+): (.*?) ---\nURL: (\S+)(?:\nPublished: (\S+))?", re.M
)
_MARKER_RE = re.compile(r"【([^】]*)】")
_URL_RE = re.compile(r"https?://[^\s】]+")
_TITLE_SPLIT_RE = re.compile(r"\s+(?:[|\-–—]|::)\s+")
# GFM table delimiter row, e.g. "|---|:--:|" or "--- | ---"
_TABLE_DELIM_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+\"[^\"]*\")?\)")


_SOURCE_NUM_RE = re.compile(r"^--- SOURCE (\d+):", re.M)


def renumber_sources(tool_outputs: List[str]) -> List[str]:
    """Number search sources consecutively across all searches of one turn.

    Every search numbers its own results from 1, so a second search in the
    same answer would reuse 1, 2, 3... and its citations would resolve to the
    first search's pages. Shifting each output past the previous ones makes
    every number unique. The model input and the citation resolver both use
    this, so they always agree.
    """
    renumbered, offset = [], 0
    for text in tool_outputs:
        numbers = [int(n) for n in _SOURCE_NUM_RE.findall(text or "")]
        if offset and numbers:
            text = _SOURCE_NUM_RE.sub(lambda m: f"--- SOURCE {int(m.group(1)) + offset}:", text)
        renumbered.append(text)
        offset += max(numbers, default=0)
    return renumbered


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
    # A "|" anywhere in the link would split a markdown table cell, so it is
    # encoded in the URL and replaced in the label/title.
    url = source["url"].replace("|", "%7C").replace(" ", "%20")
    label = site_label(source.get("title", ""), url).replace("]", ")").replace("|", "-")
    title = (source.get("title") or label).replace('"', "'").replace("|", "-")
    if source.get("date"):
        title = f"{title} ({source['date']})"
    return f"[{label}]({url} \"{title}\")"


_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def _code_lines(lines):
    """Indexes of lines inside fenced code blocks (``` or ~~~), fences included."""
    inside, fence, result = False, "", set()
    for i, line in enumerate(lines):
        match = _FENCE_RE.match(line)
        if match and (not inside or match.group(1) == fence):
            inside, fence = not inside, match.group(1)
            result.add(i)
        elif inside:
            result.add(i)
    return result


def _table_rows(lines):
    """Indexes of lines that belong to a GFM table (header, delimiter, body).

    Lines inside fenced code blocks are never table rows, so code containing
    "|" (shell pipes, ASCII tables) keeps its URLs.
    """
    code = _code_lines(lines)
    rows = set()
    i = 0
    while i < len(lines):
        if i in code:
            i += 1
            continue
        if _TABLE_DELIM_RE.match(lines[i]) and i > 0 and "|" in lines[i - 1] and i - 1 not in code:
            rows.update({i - 1, i})
            j = i + 1
            while j < len(lines) and j not in code and lines[j].strip() and "|" in lines[j]:
                rows.add(j)
                j += 1
            i = j
        else:
            i += 1
    return rows


_BARE_URL_RE = re.compile(r"<?https?://[^\s|>]+>?")


def strip_table_links(text: str) -> str:
    """Remove citation markers, markdown links and bare URLs from table rows
    entirely: tables hold the data, sources are cited below them."""
    lines = text.split("\n")
    for i in _table_rows(lines):
        line = _MARKER_RE.sub("", lines[i])
        line = _MD_LINK_RE.sub("", line)
        line = _BARE_URL_RE.sub("", line)
        # Tidy what the removal leaves behind: "(see )", doubled spaces, " ,"
        line = re.sub(r"\(\s*(?:see|source|via|ref)?\s*\)", "", line, flags=re.I)
        line = re.sub(r"[ \t]{2,}", " ", line)
        line = re.sub(r"\s+([,.;:])", r"\1", line)
        lines[i] = re.sub(r"\s+\|", " |", line)
    return "\n".join(lines)


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
    text = strip_table_links(text)
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
