# Components

Chat UI and the pieces shared by the whole app. The Code page is in
[`code/`](code/README.md), settings in [`settings/`](settings/README.md).

## Chat screen

```
App
├─ Sidebar ─────────────── new chat, Search chats (button), Code, chat list, UserMenu
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

State comes from hooks (see [`../hooks/README.md`](../hooks/README.md));
components receive data and callbacks as props and don't call the backend,
except small self-contained ones noted below.

## Layout of the input

The chat input is absolutely positioned in `App.jsx`. With no messages it is
lifted to the middle of the screen (`slideUp`, measured with a
`ResizeObserver`); with messages it sits at the bottom. The move is a CSS
transform, animated only after the first measurement so returning from the
Code page doesn't slide.

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
