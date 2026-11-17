# Chat

The assistant itself: a LangGraph graph that streams the model's answer and
calls tools when it needs them.

## How it works

1. `POST /api/chat/stream` (router `app/router/chat.py`) checks the message,
   takes the per-thread run lock, and calls `ChatService.stream_message`
   (`app/services/chat.py`).
2. If the user picked **Blogs** or **Deep research** in the tools menu, that
   path runs instead (see [blogs](blogs.md), [deep research](deep-research.md)).
   Otherwise the chat graph runs.
3. The graph (`app/services/chatbot.py`) has two nodes:
   - `chat_node` builds one system message (base prompt, a search
     instruction if the user turned search on, the
     [personalization](settings.md) profile, the
     [knowledge base](documents-and-knowledge.md) list, enabled
     [skills](skills.md), [connector](connectors.md) tools), adds document
     context for the question when the thread has files, binds the tools and
     streams the model.
   - `tool_node` runs the tool calls. It builds its tool list on each call,
     because connector tools change while the app runs.
4. `ChatService._relay_chat_stream` turns graph output into SSE events for
   the browser:

| Event `message_type` | Meaning |
|---|---|
| `thinking` | A status line ("Using Search...") or the model's reasoning |
| `ai` | Answer text |
| `ai_replace` | The final answer with citation markers turned into links |
| `approval` / `approval_done` | A connector tool asks before acting, then the answer |
| `research`, `progress` | Deep research and blog progress |
| final event | `done` with the thread id, or `error` |

5. The answer is saved in the thread's checkpoint; the first message of a
   new thread gets a title from the small model (`app/services/thread.py`).

## Tools

Always offered: `Search` (Parallel, falling back to Brave), `Weather`,
`Calculator`, `Stock_price` (`app/tools/`). Offered when relevant:
`Knowledge` (the knowledge base has documents), `Skill` (skills are on),
connector tools named `server__tool`. A tool error becomes a short message
the model can act on instead of failing the reply.

## Threads and temporary chats

- Saved chats are LangGraph checkpoints in MySQL
  (`app/database/mysql_checkpoint.py`); older checkpoints beyond
  `MAX_CHECKPOINTS_PER_THREAD` are deleted. Titles and timestamps are in
  `thread_metadata`.
- Temporary chats run on an in-memory checkpointer (`chatbot_memory`) and are
  never written to the database. They are forgotten when the browser ends
  them, after an hour idle, or on restart.
- Stop: the browser aborts the stream; the partial answer is saved and any
  pending connector approval is denied.

## API

`POST /api/chat/stream`, `/chat/edit` (edit a message and regenerate),
`/chat/regenerate`, `/chat/temp/{id}/end`, `/chat/approvals/{id}`;
`GET /api/threads`, `GET /api/threads/{id}`, `POST /api/threads/new`,
`PUT /api/threads/{id}/title`, `DELETE /api/threads/{id}`. Full list at
`/docs` on a running backend.

## Pitfalls

- Exactly one system message, first: Anthropic-compatible APIs reject others.
- A tool offered to the model must be in the tool node's list too, or the
  call fails.
- Streamed chunks are merged into one message before saving; yielding raw
  chunks would drop the tool calls.

## Tests

`tests/test_chat_node.py`, `tests/test_api.py`, `tests/test_citations.py`,
`tests/test_checkpointer.py`, `tests/test_mcp_tools.py`.
