# OpenGPT frontend

React 18, Vite 5, Tailwind 3, React Router 6, plain JavaScript (JSX). It talks
only to the OpenGPT backend.

```bash
npm install
npm run dev       # http://localhost:3000; /api is proxied to the backend on :8000
npm run build     # production build in dist/ (the check to run before committing)
npm run preview   # serve the build
```

Settings in `frontend/.env.local` (optional): `VITE_API_URL` when the backend
isn't at `/api` on the same host, `VITE_API_TOKEN` when the backend sets
`API_TOKEN`.

## Layout

| Path | What's inside | Read |
|---|---|---|
| `src/App.jsx` | Reads the URL and lays out sidebar, chat or Code page, settings, search window, shortcuts | |
| `src/components/` | Chat UI, sidebar, search window, model menu, message rendering | [README](src/components/README.md) |
| `src/components/code/` | The Code page | [README](src/components/code/README.md) |
| `src/components/settings/` | The settings popup and its pages | [README](src/components/settings/README.md) |
| `src/components/ui/` | Small generic pieces: prompt input, code block, tooltip, textarea | |
| `src/hooks/` | State per screen: chat streaming, threads, coding sessions, settings | [README](src/hooks/README.md) |
| `src/services/api.js` | Every backend call, one service object per area | |
| `src/lib/` | Plain helpers (below) | |
| `src/assets/` | Official logos, with `SOURCES.md` per folder | |

`src/lib/`: `shortcuts.js` (keyboard shortcuts, defined once),
`preferences.js` (General settings shared app-wide), `modelChoice.js` (the
model menu's choice per page), `notify.js` (notification and sound when a
reply finishes in a background tab), `citations.js` (source links),
`research.js` (reading a deep research activity log), `exportReport.js` and
`openReport.jsx` (download or open a report), `attachmentPreview.js`
(previews of attached documents), `utils.js` (`cn` for class names).

Components and hooks open with a JSDoc comment describing their props or
return value. Rules for working here: [AGENTS.md](AGENTS.md). How the whole
app fits together: [docs/architecture.md](../docs/architecture.md).
