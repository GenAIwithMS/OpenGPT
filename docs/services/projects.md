# Projects

Chats grouped with shared instructions and files, like projects in other chat
assistants. Not to be confused with coding projects on the Code page
([coding agent](coding-agent.md)), which are folders on disk.

## Files

`app/services/projects.py`, the `projects` table and
`thread_metadata.project_id` (`app/database/models.py`), `/api/projects`
(`app/router/projects.py`), `frontend/src/components/projects/ProjectView.jsx`,
the Projects section and "Move to project" in `Sidebar.jsx`,
`hooks/useProjects.js`.

## What a project has

- **Name** (at most 100 characters).
- **Instructions** (at most 8,000 characters). They go into the system prompt
  of every chat in the project, after the user's profile and custom
  instructions, and the prompt says they win where the two disagree.
- **Files** (PDF, Markdown or text, at most `MAX_PROJECT_FILES`, default 50).
  They use the same storage, embeddings and size limit as files attached to a
  chat (see [documents and knowledge](documents-and-knowledge.md)), under the
  project's id. On every message in the project's chats, the most relevant
  passages from the project's files are added to the question, together with
  passages from the chat's own files (labelled "Project files" and "Files
  attached to this chat" when both have any). The file names are listed in
  the system prompt.
- **Chats**: a chat belongs to at most one project
  (`thread_metadata.project_id`).

Saved memories, chat history search, the knowledge base, skills and
connectors work in project chats the same as anywhere else.

## In the app

- The sidebar lists projects above Recents, with **New project**. Chats in a
  project are listed on the project's page, not in Recents.
- A project's page (`/project/<id>`) has a message box that starts a new chat
  in the project, the instructions and files, and the project's chats. Its
  menu renames the project, edits the instructions or deletes the project.
- A chat in a project shows the project's name above it; clicking it opens the
  project.
- Any chat's sidebar menu has **Move to project** (and **Remove from project**
  for a chat in one). Moving a chat doesn't move its own files: they stay with
  the chat.
- Deleting a project deletes its chats, instructions and files, after a
  confirmation that says how many chats go with it.
- Temporary chats can't be in a project.

## How a chat joins a project

The project page creates the chat first (`POST /api/threads/new` with
`{"project_id": ...}`) and then sends the first message to it, so the chat is
in the project before the model answers. `chat_node` looks up the chat's
project on each model call (`projects.project_for_thread`), so moving a chat
takes effect on its next message.

## API

| Route | Does |
|---|---|
| `GET /api/projects` | All projects, most recently used first (a chat's activity counts) |
| `POST /api/projects` | Create `{name, instructions}` |
| `GET /api/projects/{id}` | The project with `threads` (chats that have messages), `files`, `max_files`, `max_mb` |
| `PUT /api/projects/{id}` | Change `name` and/or `instructions` |
| `DELETE /api/projects/{id}` | Delete it with its chats and files; returns `{deleted_chats}` |
| `POST /api/projects/{id}/files` | Add a file (multipart `file`) |
| `DELETE /api/projects/{id}/files/{file_id}` | Remove a file |
| `PUT /api/threads/{thread_id}/project` | Move a chat: `{"project_id": "..."}`, or `null` to take it out |

`GET /api/threads` returns each chat's `project_id`.

## Database

The `projects` table is created at startup like any new table. Older
databases get `thread_metadata.project_id` (and its index) from
`_add_missing_columns()` in `app/database/init_db.py`.

## Not covered yet

- The coding agent doesn't use chat projects.
- Project files are searched by meaning on every message; a project with
  many files only sends the best few passages, not whole files.

See [decision 0009](../decisions/0009-projects.md).

## Tests

`tests/test_projects.py` (projects, chats in a project, files, the prompt and
document context, routes).
