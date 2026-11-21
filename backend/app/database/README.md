# Database

MySQL through SQLAlchemy. Tests use SQLite in memory
(`tests/_helpers.use_sqlite()`).

| File | Owns |
|---|---|
| `config.py` | `DatabaseConfig`: the engine and session factory from `MYSQL_*` |
| `models.py` | All tables |
| `init_db.py` | Startup: create the database and missing tables, small upgrade steps |
| `mysql_checkpoint.py` | `MySQLCheckpointSaver`: LangGraph chat history in MySQL |

## Tables

| Table | Holds | Used by |
|---|---|---|
| `checkpoints`, `checkpoint_writes` | Chat history (LangGraph checkpoints) | `mysql_checkpoint.py` |
| `thread_metadata` | Thread titles, last-used times, project and whether pinned | `services/chatbot.py`, `projects.py` |
| `projects` | Chat projects: name, instructions and whether pinned | `services/projects.py` |
| `memories` | Saved memories | `services/memory.py` |
| `app_settings` | One JSON value per key: `profile`, `general`, `skills`, `providers`, OAuth clients | settings, skills, providers, connector sign-in |
| `connectors` | MCP connectors; secrets encrypted | `services/connectors.py` |
| `code_projects` | Coding projects (folders) | `services/coding_agent/projects.py` |

## Startup

`init_database()` (called from `create_app()`):

1. connects to MySQL and creates the database if it doesn't exist;
2. `create_all()` creates missing tables;
3. runs upgrade steps for existing databases (e.g. `_upgrade_blob_columns`,
   `_add_missing_columns` for columns added later,
   dropping an old foreign key);
4. warns if chat history still uses the old pickle format (convert with
   `python -m scripts.migrate_checkpoints`).

A failure stops the backend with a message saying what to fix.

## Chat history

- Checkpoints are serialized without pickle; old pickled rows are refused
  (`LegacyCheckpointError`) until migrated.
- Older checkpoints beyond `MAX_CHECKPOINTS_PER_THREAD` are pruned.
- Writes for one thread are serialized with a per-thread lock; transient
  MySQL errors are retried.
- Deleting a thread marks it so late writes from a finishing reply are
  ignored.

Changing tables: see [Change the database](../../../docs/guides/database-changes.md).
