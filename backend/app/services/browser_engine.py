"""Start the browser engine (backend/browser_engine, Node) with OpenGPT's model provider.

The engine builds website tools with two models: the **build** model and the
**review** model (Settings > Models: "Browser build" and "Browser review",
or BROWSER_BUILD_MODEL / BROWSER_REVIEW_MODEL; both default to the chat
model). Their provider is the active one, sent to the engine as JSON on a
pipe (file descriptor in BROWSER_ENGINE_CONFIG_FD), so the API key is never on
a command line, in the environment or in a file.

API per provider:
    OpenAI itself (no base URL, or api.openai.com)  -> "responses" (everything the engine uses)
    any other OpenAI-compatible endpoint            -> "chat"
    Anthropic or an Anthropic-compatible endpoint   -> "anthropic"

For developers, to try a build from the terminal:
    python -m app.services.browser_engine mint --url https://example.com \\
        --intent "Read the main heading" --out /tmp/heading --effect read
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from app import llm

ENGINE_DIR = Path(__file__).resolve().parents[2] / "browser_engine"
CLI = ENGINE_DIR / "dist" / "typescript" / "src" / "standalone" / "cli.js"
MCP_CLI = ENGINE_DIR / "dist" / "typescript" / "src" / "standalone" / "mcp-cli.js"
MIN_NODE_MAJOR = 24


class EngineUnavailable(RuntimeError):
    """The engine can't start here; the message says what is missing."""


def api_for(provider: str, base_url: Optional[str]) -> str:
    if provider == llm.ANTHROPIC:
        return "anthropic"
    if not base_url or "api.openai.com" in base_url:
        return "responses"
    return "chat"


def config() -> dict:
    """The engine's model configuration from the active provider (contains the API key)."""
    cfg = llm.settings()
    out = {
        "api": api_for(cfg["provider"], cfg["base_url"]),
        "buildModel": cfg["browser_build_model"],
        "reviewModel": cfg["browser_review_model"],
    }
    if cfg["api_key"] and cfg["api_key"] != "not-needed":
        out["apiKey"] = cfg["api_key"]
    if cfg["base_url"]:
        out["baseUrl"] = cfg["base_url"]
    context = llm.env("BROWSER_CONTEXT_TOKENS")
    if context:
        out["contextTokens"] = int(context)
    if (llm.env("BROWSER_REASONING_EFFORT") or "").lower() in ("1", "true", "yes", "on"):
        out["reasoningEffort"] = True
    return out


def node_path() -> str:
    """Node 24 for the engine: BROWSER_ENGINE_NODE, or node on PATH."""
    node = llm.env("BROWSER_ENGINE_NODE") or shutil.which("node")
    if not node:
        raise EngineUnavailable("Node.js 24 is needed for the browser engine. Install it, or set BROWSER_ENGINE_NODE.")
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise EngineUnavailable(f"Couldn't run {node}. Set BROWSER_ENGINE_NODE to a Node.js 24 binary.")
    if major != MIN_NODE_MAJOR:
        raise EngineUnavailable(f"The browser engine needs Node.js 24; {node} is {version}. "
                                "Set BROWSER_ENGINE_NODE to a Node.js 24 binary.")
    return node


def check() -> None:
    """Raise EngineUnavailable with what is missing (Node 24, a built engine)."""
    node_path()
    if not CLI.exists():
        raise EngineUnavailable("The browser engine isn't built. Run: cd backend/browser_engine && "
                                "pnpm install --frozen-lockfile && pnpm build")


def start(entry: Path, args: list[str], **popen) -> subprocess.Popen:
    """Start an engine entry point with the model configuration on a pipe."""
    check()
    read_fd, write_fd = os.pipe()
    try:
        env = {**os.environ, "BROWSER_ENGINE_CONFIG_FD": str(read_fd)}
        env.pop("OPENAI_API_KEY", None)  # the engine uses the configuration, nothing else
        process = subprocess.Popen([node_path(), str(entry), *args], env=env, pass_fds=(read_fd,),
                                   cwd=str(ENGINE_DIR), **popen)
    finally:
        os.close(read_fd)
    with os.fdopen(write_fd, "w") as pipe:
        json.dump(config(), pipe)
    return process


if __name__ == "__main__":  # python -m app.services.browser_engine <cli args>
    try:
        sys.exit(start(CLI, sys.argv[1:]).wait())
    except EngineUnavailable as e:
        sys.exit(str(e))
