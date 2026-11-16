# Frontend

React 18, Vite 5, Tailwind 3, React Router 6. Plain JavaScript (`.jsx`), no
TypeScript. Dark theme only for now.

```bash
npm run dev      # dev server on :3000, proxies /api to the backend on :8000
npm run build    # the check to run before you finish (there is no lint step)
```

## Layout

| Path | Role |
|---|---|
| `src/App.jsx` | Reads the URL (`/chat`, `/chat/<id>`, `/code`, `/code/<id>`, `?temporary-chat=true`) and lays out the sidebar, chat or Code page, settings popup, search window and keyboard shortcuts. |
| `src/services/api.js` | Every backend call. One `xxxService` object per area (chat, settings, connectors, skills, providers, code). |
| `src/hooks/` | State per screen: chat streaming (`useChat`), threads, coding sessions and workspace, settings. |
| `src/components/` | Chat UI, sidebar, search window, message rendering. |
| `src/components/code/` | The Code page. |
| `src/components/settings/` | The settings popup: one page per section, shared `controls.jsx`. |
| `src/components/ui/` | Small generic pieces (prompt input, code block, tooltip). |
| `src/lib/` | Plain helpers: shortcuts, preferences, notifications, citations. |
| `src/assets/` | Bundled images, e.g. official logos with a `SOURCES.md`. |

## Rules

- **Backend calls go through `src/services/api.js`.** Add a method to the
  right service object; components never call `fetch`/`axios` directly
  (except streaming, which `api.js` also wraps). Errors arrive as `Error` with
  the backend's readable message in `e.message`: show it.
- **Settings pages** use the pieces in `settings/controls.jsx`: `PageHeader`,
  `Section`, `Row`, `Toggle`, `Select`, `Modal`, `inputClass`. Don't make a
  new modal or input style.
- **Popups and menus animate in**: windows use `animate-backdrop-in` on the
  overlay and `animate-dialog-in` on the panel; menus use `animate-menu-in`
  with an `origin-*` class on the side of their button (`src/index.css`).
- **Icons** come from `lucide-react` 0.344. Check a name exists in that
  version before using it (e.g. there is `Home`, not `House`).
- **Brand logos** must be the real ones: `simple-icons` first; otherwise
  download the official mark from the company's own site into
  `src/assets/<area>/` and add its source to that folder's `SOURCES.md`.
  Never draw an imitation.
- **Keyboard shortcuts** are defined once in `src/lib/shortcuts.js` and
  listed in Settings > Shortcuts. Avoid combinations browsers reserve
  (Ctrl+N/T/W, Ctrl+Shift+E/J/Y).
- **Accessibility.** Buttons are `<button type="button">` with a text label or
  `aria-label`; dialogs have `role="dialog"` and an `aria-label`; everything
  works with the keyboard and Escape closes popups.
- **Don't add UI libraries** for something a few lines of Tailwind can do.
- **No secrets in the frontend.** `VITE_*` values are public once built; the
  only one is the optional `VITE_API_TOKEN` for a self-hosted backend.

## Checking changes in a browser

Build against a test backend on another port, serve it, and look:

```bash
VITE_API_URL=http://127.0.0.1:8001/api npx vite build --outDir /tmp/fe-dist --emptyOutDir
npx vite preview --outDir /tmp/fe-dist --port 4317
```

Don't use or restart the developer's servers on :3000 and :8000.
