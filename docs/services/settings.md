# Settings

The settings popup (footer menu > Settings). Each page stores its data in the
backend; preferences that only affect this browser (e.g. the shortcut list)
need no storage.

| Page | Stored by | Notes |
|---|---|---|
| Account | | Local profile summary |
| General | `app/services/settings.py`, section `general` | New chats temporary by default; notification and sound when a reply or coding task finishes in a background tab |
| Shortcuts | `frontend/src/lib/shortcuts.js` | Defined once, listed on the page |
| Personalization | `settings.py` section `profile`; knowledge in [documents](documents-and-knowledge.md) | Nickname, occupation, about you, custom instructions |
| Connectors | [connectors](connectors.md) | |
| Skills | [skills](skills.md) | |
| Developer | [providers](providers.md) | |

## Profile and general settings

- Stored in the `app_settings` table, one JSON value per section, validated by
  pydantic models that reject unknown fields. A stored value that no longer
  fits the schema falls back to defaults instead of failing.
- `GET /api/settings` returns all sections and the display name;
  `PUT /api/settings` takes a partial update, e.g.
  `{"general": {"sound_on_finish": true}}`.
- `personalization.profile_text()` turns the profile into text for the chat
  system prompt; the coding agent gets the same text as an instruction entry
  before every turn.

## Adding a setting

See [Add a settings page](../guides/add-a-settings-page.md).

## Tests

`tests/test_settings.py`, `tests/test_personalization.py`.
