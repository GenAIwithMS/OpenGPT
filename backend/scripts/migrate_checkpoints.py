"""One-time migration: convert pickled checkpoints to the safe serde format.

Older versions stored checkpoints with pickle. The app no longer unpickles
database content (that would let anyone who can write to the database run
code), so existing rows must be converted once. Only run this on a database
you trust, because this script does unpickle the old rows.

    cd backend
    python -m scripts.migrate_checkpoints            # convert
    python -m scripts.migrate_checkpoints --dry-run  # only count
"""
import argparse
import pickle

from sqlalchemy import create_engine, text

from app.database.config import DatabaseConfig
from app.database.mysql_checkpoint import SERDE_MAGIC, dumps

TABLES = {
    "checkpoints": {
        "key": ["thread_id", "checkpoint_ns", "checkpoint_id"],
        "blobs": ["checkpoint", "meta"],
    },
    "checkpoint_writes": {
        "key": ["thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx"],
        "blobs": ["value"],
    },
}


def migrate(dry_run: bool = False) -> None:
    engine = create_engine(DatabaseConfig.get_connection_url())
    for table, spec in TABLES.items():
        key, blobs = spec["key"], spec["blobs"]
        converted = dropped = skipped = 0
        with engine.begin() as conn:
            rows = conn.execute(text(f"SELECT {', '.join(key + blobs)} FROM `{table}`")).fetchall()
            for row in rows:
                ids = dict(zip(key, row[: len(key)]))
                values = dict(zip(blobs, row[len(key):]))
                legacy = {
                    col: blob for col, blob in values.items()
                    if blob is not None and not bytes(blob).startswith(SERDE_MAGIC)
                }
                if not legacy:
                    continue
                where = " AND ".join(f"`{k}` = :{k}" for k in key)
                try:
                    new_values = {col: dumps(pickle.loads(blob)) for col, blob in legacy.items()}
                except Exception as exc:
                    if table == "checkpoint_writes":
                        # Unreadable pending write (e.g. a saved API error): drop it.
                        if not dry_run:
                            conn.execute(text(f"DELETE FROM `{table}` WHERE {where}"), ids)
                        dropped += 1
                    else:
                        print(f"  skipped {table} {ids}: {type(exc).__name__}: {exc}")
                        skipped += 1
                    continue
                if not dry_run:
                    sets = ", ".join(f"`{col}` = :new_{col}" for col in new_values)
                    params = {**ids, **{f"new_{col}": v for col, v in new_values.items()}}
                    conn.execute(text(f"UPDATE `{table}` SET {sets} WHERE {where}"), params)
                converted += 1
            if dry_run:
                conn.rollback()
        verb = "would convert" if dry_run else "converted"
        print(f"{table}: {verb} {converted} rows, dropped {dropped} unreadable, skipped {skipped}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="count rows without changing them")
    migrate(parser.parse_args().dry_run)
