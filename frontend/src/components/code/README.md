# Code page

The screen for the coding agent (`/code` and `/code/<session id>`). The
backend side is described in
[docs/services/coding-agent.md](../../../../docs/services/coding-agent.md).

```
CodeView (../CodeView.jsx)
├─ header: ProjectPicker ─► FolderBrowser (open a folder), SavedApprovals
├─ notice when the agent is starting or unavailable (from /api/code/status)
├─ start screen: Composer ─► creates a session in the chosen project, then sends
└─ session: CodeMessages ─► ToolCard (each tool call), ApprovalCard (each request)
             Composer: text, ModelPicker (page="code"), Send / Stop
```

## State

| Owner | Holds |
|---|---|
| `useCodeWorkspace` (hooks) | Agent status (polled while starting), projects, the chosen project (saved in this browser), its sessions. Shared with the sidebar, which lists the sessions. |
| `useCodeSession` (hooks) | The open session: messages, streaming, approvals, stop. |
| App | The URL: which session is open. |

## Files

| File | Shows |
|---|---|
| `ProjectPicker.jsx` | Recent projects, Open a folder, New project, Remove from list; the project's saved "always" approvals with Revoke |
| `FolderBrowser.jsx` | Folders inside the allowed roots; choose one to open as a project |
| `CodeMessages.jsx` | The conversation: your tasks, the agent's text and reasoning, tool calls and approvals in order |
| `ToolCard.jsx` | One tool call in one line (`toolSummary`: the command, file, pattern or URL), expandable to its output or error |
| `ApprovalCard.jsx` | The agent asks: what it wants to do, the diff for edits; Allow once, Always allow (this project), Deny with an optional reason |
| `DiffView.jsx` | A unified diff with added / removed lines |

## Behaviour

- Edits, commands, web access and connector tools always ask; reading the
  project doesn't.
- While a turn runs, Send becomes Stop. When a turn ends in a background tab,
  a notification and sound can play (Settings > General).
- An approval left open when the page reloads is shown again from
  `/api/code/sessions/{id}/approvals`.
