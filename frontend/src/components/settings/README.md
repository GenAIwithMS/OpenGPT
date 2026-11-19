# Settings

The settings popup, opened from the user menu, Ctrl/Cmd+, or any part of the
UI with `OPEN_SETTINGS_EVENT` (e.g. the model menu's "Change").

```
SettingsModal ── navigation (SECTIONS, searchable) + the chosen page
├─ AccountPage          profile summary
├─ GeneralPage          temporary by default, notification, sound
├─ ShortcutsPage        lib/shortcuts.js, grouped
├─ PersonalizationPage  Profile tab, Knowledge tab (documents)
├─ ConnectorsPage       added connectors, Browse catalog, Create, sign-in
├─ SkillsPage           skills by source, detail, Explore, Add
└─ DeveloperPage        models in use, providers
   └─ LocalModels       Find local models: running servers, downloaded models
UserMenu                footer menu (Account, Settings, help links)
```

## Building blocks (`controls.jsx`)

Every page uses these instead of its own styles: `PageHeader`, `Section`,
`Row` (label, description, control), `Toggle`, `Select` (themed dropdown),
`Modal` (dialog above the popup), `inputClass` (inputs and textareas),
`Avatar`. Logos: `ConnectorLogo`, `ProviderLogo` (official marks; see
`src/assets/*/SOURCES.md`).

## Data

| Page | Reads and writes | Service in `api.js` |
|---|---|---|
| General, Personalization profile | `/api/settings` through `useSettings` (saved at once, rolled back if refused) | `settingsService` |
| Knowledge | `/api/settings/knowledge` | `settingsService` |
| Connectors | `/api/connectors` | `connectorsService` |
| Skills | `/api/skills` | `skillsService` |
| Developer | `/api/providers`, `/api/providers/local` | `providersService` |

Pages other than General and Personalization load their own data when they
open; the popup passes only `settings` and `save`.

## Patterns

- **Changes that restart the coding agent** (connectors, skills, provider)
  say so on the page.
- **Secrets** (keys, tokens) are sent once and never come back; pages show
  only "key saved" or the names of saved values.
- **Connector sign-in** (`ConnectorsPage`): `signInWindow()` opens a small
  window first (so it isn't blocked), asks the backend where to go, and
  waits for the callback page's `postMessage` or the window closing. GitHub's
  device flow shows a code in `DeviceSignInHost` and polls until authorized.
- **Status after a change**: the connectors page re-checks every few seconds
  until each connector used in chat reports connected or an error.
- **Removing** asks inline ("Remove?") instead of a separate dialog.
