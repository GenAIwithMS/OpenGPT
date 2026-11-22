# Components

Chat UI and the pieces shared by the whole app. The Code page is in
[`code/`](code/README.md), settings in [`settings/`](settings/README.md).

## Chat screen

```
App
├─ Sidebar ─────────────── new chat, Search chats (button), Code, Projects (each
│                          with its chats and menu), chat list; chat menu: Share,
│                          Rename, Pin, Move to project (hover submenu), Remove
│                          from project, Delete; Agent (with a badge); UserMenu
├─ agent/AgentView ────── the Agent page (/agent): new task, a session's timeline,
│                          question and approval cards, Stop, Continue
├─ projects/ProjectView ── a project's page (/project/<id>): new chat box,
│                          instructions, files, chats; NewProjectDialog,
│                          ProjectSettingsDialog (sidebar "Project settings")
├─ MessageList ─────────── messages (memoized MessageItem)
│   ├─ ThinkingIndicator   live status and reasoning while the model works
│   ├─ ResearchCard / ReportCard ─► ResearchPanel (side panel: activity or report)
│   ├─ ChatApprovalCard    a connector tool asks before acting
│   ├─ CitationChip        source pills in answers
│   ├─ AttachmentCard      documents sent with a message
│   └─ MessageActions      copy, feedback, regenerate, which model answered
├─ MessageInput ────────── text, attachments, + menu (file, search, blogs,
│                          deep research), ModelPicker, Send / Stop
├─ SearchPalette ───────── the search window (Ctrl/Cmd+K)
└─ SettingsModal ───────── settings/
```

`Logo` (the name with the speaking O as its first letter) is in the sidebar
and page headers; `LogoMark` (the O alone) is on the collapsed sidebar. Both
take the text colour. Source files and rules: [`/logo`](../../../logo/README.md).

State comes from hooks (see [`../hooks/README.md`](../hooks/README.md));
components receive data and callbacks as props and don't call the backend,
except small self-contained ones noted below.

## Layout of the input

The chat input is absolutely positioned in `App.jsx`. With no messages it is
lifted to the middle of the screen (`slideUp`, measured with a
`ResizeObserver`); with messages it sits at the bottom. The move is a CSS
transform, animated only after the first measurement so returning from the
Code page doesn't slide.

## ProjectView

- The page at `/project/<id>`. It loads the project (with its chats and
  files) and saves the name, instructions and files itself through
  `projectService`; App passes the message box handlers and deletes the
  project after a confirmation.
- Sending the first message: App creates the chat in the project
  (`chatService.createThread(projectId)`), opens it and sends, so the reply
  streams on the chat page.

## SearchPalette

- Opens from the sidebar's "Search chats" button and Ctrl/Cmd+K; App owns
  the open state and passes the chat list and the actions.
- Loads coding projects and their sessions itself when it opens (up to 12
  projects); without the coding agent it still searches chats.
- Types: All, Chats, Projects, Sessions. Empty input shows Recents and
  Actions; typing groups matches.
- Keyboard: focus stays in the input. Up / Down move, Enter opens, Left /
  Right change the type when the input is empty or the cursor is at its
  edge, Escape closes.

## ModelPicker

- The model menu next to Send in chat and Code (`page="chat"` / `"code"`).
- Loads `/api/providers/models` once per page load. Shows Auto, then the
  models set for each job with what each is for, then **More models** (a
  side panel with search), and a link that opens Settings > Developer
  (`OPEN_SETTINGS_EVENT`).
- Rendered into `document.body` with fixed positioning so the input box
  never clips it. Opens below the button; above only when there is no room.
  The side panel goes right of the menu, or left when it doesn't fit.
- Keyboard: focus starts on the current choice; Up / Down move, Right opens
  More models, Left returns, Enter picks, Escape closes and refocuses the
  button. Hovering More models opens it.
- The choice is saved per page in this browser (`lib/modelChoice.js`) and
  `services/api.js` sends it with each message.

## ChatApprovalCard

Shown inside the assistant message when a connector tool asks first. It
posts Allow / Deny itself (`chatService.answerApproval`); the result arrives
as an `approval_done` event and the card shows Allowed or Denied.

## Shared

- `ConfirmationModal`: "are you sure?" dialogs (focus trapped, Escape cancels).
- `DownloadMenu`: save a report as PDF, Markdown or text.
- `ErrorBoundary`: a fallback instead of a blank page if rendering crashes.
- `ui/prompt-input.jsx`: the auto-growing input used by chat and Code. Enter
  sends, Shift+Enter adds a line, Enter while an IME is composing doesn't send.
- `ui/code-block.jsx`: highlighted code blocks with copy.

Popups use the `animate-backdrop-in`, `animate-dialog-in` and
`animate-menu-in` classes from `index.css`.
