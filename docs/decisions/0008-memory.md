# 0008. Memory: saved facts plus searching past chats; files stay per chat

Status: accepted (2026-11-21)

## Context

Users wanted the assistant to remember them across chats, like other chat
assistants, and asked why a new chat couldn't use a file attached in an
earlier one. Each chat's files were private to it, and nothing carried over
between chats except the profile and the knowledge base.

## Decision

Two parts, each with its own switch (both on by default):

- **Saved memories**: short facts the model saves with tools (Remember,
  Update_memory, Forget), shown to the user ("Memory updated") and managed in
  Settings. All of them go into the system prompt.
- **Chat history**: a Chat_history tool that searches other chats' messages
  and their files when the user refers to them.

Files stay private to their chat. A new chat doesn't automatically search
every file ever attached: answers would mix in text from unrelated documents
without the user noticing. Files reach another chat only through Chat_history,
when the user refers to them; files every chat should use go in the knowledge
base, and later in projects.

Because the model writes memories and also reads web pages and documents,
the prompt allows saving only what the user says about themselves, and
memories are given to the model as notes, not instructions. The user sees
every change and can delete it.

Temporary chats never read or change memory.

## Consequences

- No extra model call: memory is just tools and prompt text.
- All memories are in every prompt, so the list is capped (200 facts of 300
  characters, about 8,000 characters in the prompt).
- Message search is keyword based; it can miss a chat that used different
  words. Embedding chat text could replace it later without changing the tool.
- A prompt-injected page could still try to get a fact saved; the rules and
  the visible "Memory updated" note limit this, but don't rule it out.
