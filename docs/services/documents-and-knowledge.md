# Documents and knowledge

Three ways to give the assistant documents, built on the same code
(`app/services/rag.py`):

- **Chat documents**: files attached to one chat. Every question in that
  chat gets the most relevant passages added to it. Other chats don't see
  them, except through [chat history](memory.md) when the user refers to them.
- **Knowledge base** (Settings > Personalization > Knowledge,
  `app/services/knowledge.py`): files every chat can search. The model gets a
  `Knowledge` tool and the list of document names, and calls the tool when a
  question may relate to them.
- **Project files** ([projects](projects.md), `app/services/projects.py`):
  files every chat in one project uses. Like chat documents, each question in
  those chats gets the most relevant passages added, from both the project's
  files and the chat's own.

## How it works

1. Upload (`POST /api/upload-pdf` for a chat, `POST /api/settings/knowledge`
   for the knowledge base, `POST /api/projects/{id}/files` for a project). The router checks type (`.pdf`, `.md`, `.txt`),
   size (`MAX_UPLOAD_MB`) and that the content really is that type.
2. `rag.ingest_document` stores the file and a small metadata file in
   `backend/app/storage/documents/`, splits the text into chunks and embeds
   them with a local model (`EMBEDDING_MODEL`, no API calls) into an in-memory
   FAISS index.
3. On a question, `retrieve_from_document` searches the index. Indexes are
   cached in memory (`MAX_CACHED_RETRIEVERS`) and rebuilt from the stored
   files when needed, e.g. after a restart.
4. The knowledge base is a document set under a reserved id
   (`00000000-0000-4000-8000-00000000004b`) that no chat uses, at most
   `MAX_KNOWLEDGE_FILES` files. A project's files are a document set under
   the project's id, at most `MAX_PROJECT_FILES` files.

## Pitfalls

- The embedding libraries are imported on first use, so the first upload or
  question takes a few seconds.
- Deleting a chat deletes its documents; deleting a project deletes its
  files (and its chats). Deleting one file
  (`rag.delete_file`) drops the cached index; it is rebuilt from the
  remaining files on next use.
- The coding agent can't search the knowledge base yet.

## Tests

`tests/test_api.py` (uploads), `tests/test_personalization.py` (knowledge).
