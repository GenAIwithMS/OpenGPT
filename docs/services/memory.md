# Memory

What the assistant remembers between chats. Two parts, each with its own
switch in Settings > Personalization > Memory (settings section `memory`).

## Files

`app/services/memory.py`, the `memories` table (`app/database/models.py`),
`/api/settings/memories` (`app/router/settings.py`),
`frontend/src/components/settings/MemoryTab.jsx`, the "Memory updated" note in
`MessageList.jsx`.

## Saved memories (`enabled`, on by default)

- Short facts about the user, one per row (at most 300 characters, 200
  memories). All of them go into the chat's system prompt, newest first and
  up to about 8,000 characters, each with a short id in brackets.
- The model saves them with **Remember**, changes them with
  **Update_memory** and deletes them with **Forget** (by the short id). The
  prompt tells it to save only lasting things the user says about themselves
  in their own messages (name, work, projects, tools, preferences, or "remember
  that…"), never text from web pages, documents or tool results, and never
  secrets.
- Memories are presented to the model as background notes, not instructions,
  because the model writes them and also reads untrusted content.
- A reply that saved, changed or deleted a memory shows **Memory updated**
  (the `memory` stream event, or `memory_updated` on a loaded message).
  Clicking it opens the Memory tab.
- The user can add, edit, delete and delete all in Settings. Turning the
  switch off keeps the list; the model stops seeing it and the tools aren't
  offered.
- Deleting a chat doesn't delete memories saved in it (`thread_id` only
  records where it came from).

## Chat history (`chat_history`, on by default)

- **Chat_history** searches the user's other chats when they refer to an
  earlier conversation or file ("what did we decide about…", "the PDF I
  sent"). It never searches the current chat.
- Messages: the 300 most recent chats, keyword match on titles and messages,
  best matches first, at most two excerpts per chat and eight in all. A
  chat's text is cached until it changes.
- Files: each chat's files stay private to that chat; this tool is the only
  way another chat reaches them. It searches up to three chats with files:
  those whose file names or titles match the words, or, when no message
  matched, the most recent ones. It uses the same document search a chat uses
  for its own files.
- Results name the chat as `/chat/<id>`; the model links it as
  `[title](/chat/<id>)` and the link opens that chat in the app.

## Temporary chats

They never see memories, never get the memory tools and never search
history (`memory.is_temporary`: thread ids starting with `temp-`). The tools
also check this themselves.

## API

| Route | Does |
|---|---|
| `GET /api/settings/memories` | `{memories, max, max_chars}`, newest first |
| `POST /api/settings/memories` | Add `{text}` (same text twice is kept once) |
| `PUT /api/settings/memories/{id}` | Change the text |
| `DELETE /api/settings/memories/{id}` | Delete one |
| `DELETE /api/settings/memories` | Delete all |

The switches are ordinary settings: `PUT /api/settings` with
`{"memory": {"enabled": false}}` or `{"memory": {"chat_history": false}}`.

## Not covered yet

- The coding agent doesn't use memories.
- Chat history search is keyword based for messages (files use embeddings).

See [decision 0008](../decisions/0008-memory.md).

## Tests

`tests/test_memory.py` (memories, tools, history search, stream event,
routes), `tests/test_chat_node.py` (memory in normal chats only).
