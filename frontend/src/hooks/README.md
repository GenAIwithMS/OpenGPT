# Hooks

State for each screen. Components get data and callbacks from these; the
hooks call `services/api.js`.

| Hook | Owns | Used by |
|---|---|---|
| `useChat` | The open chat's messages, sending, streaming, edit, regenerate, stop | App ─► MessageList, MessageInput |
| `useThreads` | The chat list and renaming (App deletes chats through `chatService`) | App ─► Sidebar, SearchPalette |
| `useProjects` | The project list and creating a project | App ─► Sidebar |
| `useAgentSessions` | Agent sessions: polls the list, counts sessions waiting for you, notifies when one finishes or waits | App ─► Sidebar, AgentView |
| `useCodeWorkspace` | Coding agent status, projects, chosen project, its sessions (only while the Code page is open) | App ─► Sidebar, CodeView |
| `useCodeSession` | One coding session: messages, streaming, approvals, stop | CodeView |
| `useSettings` | Settings from the backend, saved optimistically | App ─► SettingsModal |

## useChat: one reply

```
sendMessage(text, tools, attachments)
  ├─ add the user message and an empty assistant placeholder
  ├─ upload attachments (a new chat gets its thread id from the first upload)
  └─ chatService.streamMessage(...)   // POST /api/chat/stream, model from the menu
       events ─► onMessage:
         thinking       status line or reasoning ─► streamingProgress
         model          which model answers ─► message.model, message.autoModel
         ai             answer text ─► message.content
         ai_replace     final text with citation links
         approval       connector tool asks ─► message.approvals[]
         approval_done  the answer ─► approval.decision
         research       deep research activity ─► message.research[]
         memory         the answer changed a saved memory ─► message.memory_updated
         progress       blog writer steps ─► streamingProgress.steps
         done           finish; a new chat gets its thread id (URL updated quietly)
         error          keep partial text, show the error
```

- **Stale replies are dropped**: every request gets an id
  (`requestIdRef`); events from an older request (another thread, a stopped
  stream) are ignored.
- **Stop** aborts the request; the backend keeps what was written.
- **Temporary chats** use a per-session id so each has its own server
  memory, ended when the chat is left or the tab closes.

## useCodeSession: one turn

`send(id, text)` streams `/api/code/sessions/{id}/stream`: `start`, `model`,
`text`, `reasoning`, `tool`, `approval`, `approval_done`, `title`, `error`,
`done` (`succeeded`, `failed` or `interrupted`). `answer()` replies to an
approval; `stop()` interrupts the turn; callbacks report titles, finished
turns and new approvals (used for notifications).
