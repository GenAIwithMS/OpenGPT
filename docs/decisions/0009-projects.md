# 0009. Projects: chats with shared instructions and files

Status: accepted (2026-11-22)

## Context

Users wanted to group related chats and give them shared context, as in
other chat assistants: instructions that apply to every chat on a topic, and
files every one of those chats can use. Until now a file was either private
to one chat or in the knowledge base for every chat, and custom instructions
applied everywhere.

## Decision

A project has a name, instructions and files, and chats belong to at most one
project (`thread_metadata.project_id`).

- **Instructions** go into the system prompt after the user's custom
  instructions, and win where they disagree, because they are the more
  specific of the two.
- **Files** are retrieved on every message, like a chat's own files, not
  through a tool like the knowledge base. Project files are the context the
  user chose for this work, so they should be used without the model having
  to decide to look; weaker models often skip optional tools. They use the
  same storage and embeddings as chat files, under the project's id.
- **Deleting a project deletes its chats**, as in other chat assistants.
  The confirmation says how many chats go with it.
- Memory, the knowledge base, skills and connectors work in projects
  unchanged. Chat history search still covers all chats.
- Temporary chats can't be in a project.
- The name "project" is shared with the Code page's coding projects; the code
  keeps them apart (`projects` vs `code_projects`, `/api/projects` vs
  `/api/code/projects`).

## Consequences

- Each message in a project chat runs one more document search when the
  project has files.
- Only the best matching passages are sent, so a question about a whole
  document (e.g. "summarise all files") sees part of it.
- Moving a chat changes its instructions and files from its next message;
  its own attached files move with it.
