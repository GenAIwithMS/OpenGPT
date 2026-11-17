# Skills

A skill is a folder with a `SKILL.md`: YAML front matter with a `name` and a
`description` (when to use it), then instructions, plus any reference files
or scripts. Skills that are on work in chat and in the coding agent.

## Files

`app/services/skills.py` (everything), `app/router/skills.py`
(`/api/skills/...`), `app/skills/` (built-in skills),
`frontend/src/components/settings/SkillsPage.jsx`.

## Where skills come from

| Source | Location | Default |
|---|---|---|
| Built-in (OpenGPT's own) | `backend/app/skills/<name>/` | on |
| Personal: created, uploaded (`.md` or `.zip`), imported from GitHub, added from Explore | `backend/app/storage/skills/<name>/` | on |
| On this computer | `~/.claude/skills`, `~/.agents/skills` (read in place) | off |

Explore lists open-source skills (Anthropic's, Apache-2.0) installed from
GitHub at a pinned commit (`_ANTHROPIC["ref"]`); they aren't copied into
this repository. Which skills are on is stored in `app_settings` (key
`skills`).

## How they are used

- **Chat**: the system prompt lists enabled skills (name and description);
  the model calls the `Skill` tool to read one's instructions, or one of its
  files. Scripts can't run in chat.
- **Coding agent**: its config gets `skills.paths` (the enabled folders). The
  agent's own discovery of `~/.claude` and `~/.agents` is turned off, so it
  loads exactly the skills that are on. Changes restart it.

## Safety

- Uploads and imports: no links, no absolute or `..` paths, no hidden
  folders; at most 300 files and 20 MB per skill and 25 skills at once.
- Only public GitHub repositories; private ones are refused.
- Imported skills are instructions and scripts written by someone else; the
  UI tells users to check them before turning them on.

## API

`GET /api/skills`, `GET /skills/catalog`, `POST /skills/catalog/{id}`,
`POST /skills` (create), `/skills/upload`, `/skills/import`,
`GET/PUT/DELETE /skills/item/{id}`, `PUT /skills/content/{id}` (edit).
Ids are `builtin/<name>`, `personal/<name>` or `local/<root>/<name>`.

## Pitfalls

- Every enabled skill adds a line to each chat request; many skills cost
  tokens on every message.
- A personal skill can't use a built-in skill's name.

## Tests

`tests/test_skills.py`.
