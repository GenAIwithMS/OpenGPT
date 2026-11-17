"""A tiny MCP server for tests: one read-only tool, one that changes data."""
import sys

from mcp.server.mcpserver import MCPServer
from mcp_types import ToolAnnotations

server = MCPServer("notes")
NOTES = ["buy milk"]


@server.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_notes() -> str:
    """List the saved notes."""
    return "\n".join(NOTES)


@server.tool(title="Add note")
def add_note(text: str) -> str:
    """Save a new note."""
    NOTES.append(text)
    return f"added: {text} ({len(NOTES)} notes)"


if __name__ == "__main__":
    server.run("stdio")
    sys.exit(0)
