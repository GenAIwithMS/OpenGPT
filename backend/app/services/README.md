# Services

The backend's logic, one module per feature. Routers call these; services
call each other, the database, `app/llm.py` and outside APIs. Most modules
open with a docstring explaining how they work; the feature pages in
`docs/services/` explain how the pieces fit.

| Module | Does | Docs |
|---|---|---|
| `chat.py` | Runs a chat turn (chat graph, blog writer or deep research) and turns it into SSE events; edit and regenerate | [chat](../../../docs/services/chat.md) |
| `chatbot.py` | The LangGraph chat graph: system prompt, tools per message, tool node, checkpointers, thread titles | [chat](../../../docs/services/chat.md) |
| `thread.py` | Thread ids and title generation | [chat](../../../docs/services/chat.md) |
| `citations.py` | Search sources to numbered links | [chat](../../../docs/services/chat.md) |
| `run_lock.py` | One reply at a time per thread | |
| `rag.py` | Document storage, chunking, local embeddings, FAISS search | [documents](../../../docs/services/documents-and-knowledge.md) |
| `knowledge.py` | The knowledge base and its `Knowledge` tool | [documents](../../../docs/services/documents-and-knowledge.md) |
| `personalization.py` | Profile text for the system prompt and the coding agent | [settings](../../../docs/services/settings.md) |
| `memory.py` | Saved memories, the memory tools and chat history search | [memory](../../../docs/services/memory.md) |
| `settings.py` | Profile, general and memory settings in `app_settings` | [settings](../../../docs/services/settings.md) |
| `providers.py` | Model providers, job models, the model menu's list | [providers](../../../docs/services/providers.md) |
| `model_router.py` | Auto: a model per message | [providers](../../../docs/services/providers.md) |
| `connectors.py` | MCP connectors: catalog, storage, specs for chat and the agent | [connectors](../../../docs/services/connectors.md) |
| `connector_oauth.py` | Connector sign-in (OAuth with PKCE, device flow, refresh) | [connectors](../../../docs/services/connectors.md) |
| `mcp_tools.py` | Live MCP connections and chat tools | [connectors](../../../docs/services/connectors.md) |
| `chat_approvals.py` | Ask the user in chat before a connector tool changes data | [connectors](../../../docs/services/connectors.md) |
| `skills.py` | Skills: sources, install, the `Skill` tool | [skills](../../../docs/services/skills.md) |
| `coding_agent/` | The coding agent integration | [README](coding_agent/README.md) |

## How services depend on each other

```
router ─► chat ─► chatbot ─► llm, knowledge, skills, mcp_tools, personalization, memory
                    └─► model_router ─► llm
router ─► connectors ◄─ connector_oauth          mcp_tools ─► connectors, chat_approvals
router ─► providers ─► llm (reload), coding_agent.process (restart)
coding_agent.config ─► llm, connectors, skills, providers
```

Keep it pointing one way: services don't import routers, and low-level
modules (`llm`, `secret_box`, `connectors`) don't import feature modules at
import time (late imports inside functions are used where a cycle would
form).
