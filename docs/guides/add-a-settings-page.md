# Add a settings page

## A simple preference (no new page)

For an on/off or choice on an existing page, e.g. General:

1. **Backend**: add the field to the section's model in
   `backend/app/services/settings.py` (e.g. `GeneralSettings`) with a default.
   Unknown fields are rejected, so the API refuses values the schema doesn't
   know.
2. **Frontend**: add a `Row` with a `Toggle` or `Select` from
   `settings/controls.jsx` to the page and save with
   `save({ general: { your_field: value } })`.
3. **Use it**: read it in the backend with `settings.get_section("general")`,
   or in the browser through `useSettings`.
4. **Test**: extend `backend/tests/test_settings.py`.

## A new page with its own data

1. **Service** in `backend/app/services/<feature>.py`. Small state goes in
   `app_settings` under a new key; records that grow go in a new table (see
   [database changes](database-changes.md)). Encrypt secrets with
   `secret_box`.
2. **Router** in `backend/app/router/<feature>.py`, included in
   `create_app()` with `Depends(require_api_token)`; bound every input with
   `Field(max_length=...)`.
3. **API client**: a `<feature>Service` object in
   `frontend/src/services/api.js`.
4. **Page** `frontend/src/components/settings/<Feature>Page.jsx` built from
   `PageHeader`, `Section`, `Row`, `Toggle`, `Select`, `Modal` and
   `inputClass`. Popups use the `animate-*` classes.
5. **Navigation**: add the section to `SECTIONS` in
   `settings/SettingsModal.jsx` (label, icon, search keywords) and render
   the page there.
6. **Docs and tests**: a service page in `docs/services/`, tests in
   `backend/tests/`, and check the page in a browser against a test backend
   (see [frontend/AGENTS.md](../../frontend/AGENTS.md)).
