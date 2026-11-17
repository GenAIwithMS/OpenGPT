# Change the database

Tables are SQLAlchemy models in `backend/app/database/models.py`.
`init_database()` (`app/database/init_db.py`) runs at startup: it creates the
database if needed, creates missing tables with `create_all()`, and runs a
few small upgrade steps.

## Small state: no table needed

Settings-like data (a few keys, a JSON value each) goes in `app_settings`
through a service: profile and general settings, skills, providers and
OAuth clients already do this.

## A new table

1. Add the model to `models.py` with a docstring, sensible lengths on
   strings and `nullable=False` where a value is required.
2. Nothing else for existing installs: `create_all()` creates it at the next
   start.
3. Tests get it automatically (`tests/_helpers.use_sqlite()` creates all
   tables in SQLite).

## A change to an existing table

`create_all()` never alters a table that exists, so existing databases need
an upgrade step:

1. Change the model.
2. In `init_db.py`, add a function that checks the current schema (e.g. with
   SQLAlchemy's `inspect`) and applies the change only when it is missing,
   like `_upgrade_blob_columns()`. Call it from `init_database()` after
   `create_all()`. It must be safe to run on every start.
3. Test it on a copy of a real MySQL database, from the old schema, and keep
   the SQLite tests passing.

## Secrets

Encrypt with `app/secret_box.py` before storing; store the token string in a
`Text` column. The key is `SETTINGS_SECRET` or `backend/app/storage/secret.key`;
without it stored secrets can't be read, so back it up with the database.
