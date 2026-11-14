"""Database Initialization Script"""
import logging
import re
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text
from app.database import DatabaseConfig
from app.database.models import Base
from app.database.mysql_checkpoint import SERDE_MAGIC

logger = logging.getLogger(__name__)


# (table, column, NOT NULL?) for columns that must be LONGBLOB. create_all()
# never changes existing tables, so older databases are upgraded here.
_LONGBLOB_COLUMNS = [
    ("checkpoints", "checkpoint", True),
    ("checkpoints", "meta", True),
    ("checkpoint_writes", "value", False),
]


def _upgrade_blob_columns():
    """Upgrade checkpoint columns from BLOB (64 KB limit) to LONGBLOB."""
    engine = DatabaseConfig.get_engine()
    with engine.begin() as conn:
        for table, column, not_null in _LONGBLOB_COLUMNS:
            data_type = conn.execute(
                text(
                    "SELECT DATA_TYPE FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c"
                ),
                {"t": table, "c": column},
            ).scalar()
            if data_type and data_type.lower() != "longblob":
                null_sql = "NOT NULL" if not_null else "NULL"
                conn.execute(text(f"ALTER TABLE `{table}` MODIFY `{column}` LONGBLOB {null_sql}"))
                logger.info(f"Upgraded {table}.{column} to LONGBLOB")


def _drop_checkpoint_writes_foreign_key():
    """Older databases have a foreign key from checkpoint_writes to checkpoints."""
    with DatabaseConfig.get_engine().begin() as conn:
        names = conn.execute(
            text(
                "SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS "
                "WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'checkpoint_writes'"
            )
        ).scalars().all()
        for name in names:
            conn.execute(text(f"ALTER TABLE `checkpoint_writes` DROP FOREIGN KEY `{name}`"))
            logger.info("Dropped foreign key %s from checkpoint_writes", name)


def _warn_about_pickled_checkpoints():
    """Old checkpoints were pickled; the app refuses to load those."""
    with DatabaseConfig.get_engine().connect() as conn:
        legacy = conn.execute(
            text("SELECT COUNT(*) FROM checkpoints WHERE LEFT(checkpoint, :n) <> :magic"),
            {"n": len(SERDE_MAGIC), "magic": SERDE_MAGIC},
        ).scalar()
    if legacy:
        logger.error(
            "%d checkpoints are still in the old pickle format and will not load. "
            "Convert them once with: cd backend && python -m scripts.migrate_checkpoints",
            legacy,
        )


class DatabaseInitError(RuntimeError):
    """The database could not be created or upgraded; the app can't run."""


def init_database():
    """Create the database and tables, and upgrade older schemas.

    Raises DatabaseInitError with a readable message on failure, so the app
    stops at startup instead of starting and failing every request.
    """
    database = DatabaseConfig.DATABASE
    if DatabaseConfig.USER == "root" and not DatabaseConfig.PASSWORD:
        logger.warning(
            "Connecting to MySQL as root with no password. For anything beyond local "
            "testing, create a dedicated MySQL user with a password and set MYSQL_USER "
            "and MYSQL_PASSWORD."
        )
    if not re.fullmatch(r"\w+", database or ""):
        raise DatabaseInitError(
            f"Invalid MYSQL_DATABASE {database!r}: use letters, digits and underscores only."
        )
    try:
        # Connect to the server (no database yet). The password is URL-escaped,
        # so characters like @ : / in it don't break the URL.
        password = quote_plus(DatabaseConfig.PASSWORD) if DatabaseConfig.PASSWORD else ""
        engine = create_engine(
            f"mysql+pymysql://{DatabaseConfig.USER}:{password}@{DatabaseConfig.HOST}:{DatabaseConfig.PORT}",
            isolation_level="AUTOCOMMIT"
        )
        try:
            with engine.connect() as conn:
                conn.execute(text(f"CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4"))
        finally:
            engine.dispose()

        # Create tables
        Base.metadata.create_all(DatabaseConfig.get_engine())
        _upgrade_blob_columns()
        _drop_checkpoint_writes_foreign_key()
        _warn_about_pickled_checkpoints()
        return True
    except Exception as e:
        # Log the details; the message names what to check without echoing SQL.
        logger.error("Database initialization failed: %s", e)
        raise DatabaseInitError(
            f"Could not set up the MySQL database '{database}' on "
            f"{DatabaseConfig.HOST}:{DatabaseConfig.PORT} as user '{DatabaseConfig.USER}'. "
            "Check that MySQL is running and the MYSQL_* settings in backend/.env are correct. "
            f"Cause: {type(e).__name__}"
        ) from e


if __name__ == "__main__":
    init_database()
