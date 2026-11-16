"""Connectors (MCP servers): validation, secrets, catalog, JSON import, agent config, routes."""
import json
import os
import unittest
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from app import secret_box  # noqa: E402
from app.database.config import DatabaseConfig  # noqa: E402
from app.database.models import Connector  # noqa: E402
from app.exceptions import ConflictError, NotFoundError, ValidationError  # noqa: E402
from app.services import connectors  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, {"SETTINGS_SECRET": "test-secret"})
        env.start()
        self.addCleanup(env.stop)
        secret_box._reset_for_tests()
        self.addCleanup(secret_box._reset_for_tests)


class SecretBoxTests(Base):
    def test_round_trip_and_wrong_key(self):
        token = secret_box.encrypt({"k": "v"})
        self.assertNotIn("v\"", token)
        self.assertEqual(secret_box.decrypt(token), {"k": "v"})
        with mock.patch.dict(os.environ, {"SETTINGS_SECRET": "other"}):
            secret_box._reset_for_tests()
            self.assertEqual(secret_box.decrypt(token, default={}), {})


class ConnectorTests(Base):
    def test_local_with_env_secret_never_returned(self):
        c = connectors.create(name="My Tool", kind="local", command="npx -y some-mcp --flag 'a b'",
                              env={"API_KEY": "sk-secret-value"})
        self.assertEqual(c["name"], "my-tool")
        self.assertEqual(c["command"], ["npx", "-y", "some-mcp", "--flag", "a b"])
        self.assertEqual(c["env_names"], ["API_KEY"])
        self.assertNotIn("sk-secret-value", json.dumps(connectors.list_connectors()))
        with DatabaseConfig.get_session_factory()() as db:
            stored = db.get(Connector, c["id"]).secrets
        self.assertNotIn("sk-secret-value", stored)  # encrypted at rest

    def test_remote_with_headers(self):
        c = connectors.create(name="docs", kind="remote", url="https://example.com/mcp",
                              headers={"Authorization": "Bearer t0ken"})
        self.assertEqual(c["header_names"], ["Authorization"])
        self.assertIsNone(c["command"])

    def test_validation(self):
        bad = [
            dict(name="Bad Name!", kind="local", command="x"),
            dict(name="ok", kind="local", command=""),
            dict(name="ok", kind="local", command=["x"] * 31),
            dict(name="ok", kind="remote", url="file:///etc/passwd"),
            dict(name="ok", kind="remote", url="javascript:alert(1)"),
            dict(name="ok", kind="local", command="x", env={"BAD-NAME": "v"}),
            dict(name="ok", kind="local", command="x", env={"K": "line1\nline2"}),
            dict(name="ok", kind="remote", url="https://e.com", headers={"Bad Header": "v"}),
            dict(name="ok", kind="other"),
        ]
        for kwargs in bad:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValidationError):
                connectors.create(**kwargs)
        self.assertEqual(connectors.list_connectors(), [])

    def test_duplicate_and_limit(self):
        connectors.create(name="one", kind="local", command="x")
        with self.assertRaises(ConflictError):
            connectors.create(name="one", kind="local", command="y")
        with mock.patch.object(connectors, "MAX_CONNECTORS", 1), self.assertRaises(ValidationError):
            connectors.create(name="two", kind="local", command="y")

    def test_every_catalog_entry_is_valid(self):
        ids = [e["id"] for e in connectors.CATALOG]
        self.assertEqual(len(ids), len(set(ids)), "catalog ids must be unique")
        for e in connectors.CATALOG:
            with self.subTest(e["id"]):
                self.assertRegex(e["id"], connectors._NAME_RE)
                for field in ("name", "description", "category", "homepage"):
                    self.assertTrue(e.get(field), f"missing {field}")
                self.assertTrue(e["homepage"].startswith("https://"))
                self.assertIn(e["kind"], ("local", "remote"))
                self.assertIn(e.get("auth", "none"), ("oauth", "key", "none"))
                if e["kind"] == "remote":
                    self.assertTrue(e["url"].startswith("https://"))
                else:
                    self.assertTrue(e["command"] and all(isinstance(p, str) and p for p in e["command"]))
                for spec in (e.get("env") or []) + (e.get("headers") or []):
                    self.assertTrue(spec.get("name") and spec.get("label"))

    def test_catalog_add(self):
        with self.assertRaises(ValidationError):
            connectors.add_from_catalog("github", {})  # token required
        c = connectors.add_from_catalog("github", {"Authorization": "ghp_abc"})
        self.assertEqual((c["kind"], c["catalog_id"], c["title"]), ("remote", "github", "GitHub"))
        self.assertTrue(next(e for e in connectors.catalog() if e["id"] == "github")["added"])
        self.assertEqual(connectors.agent_mcp_config()["servers"]["github"]["headers"],
                         {"Authorization": "Bearer ghp_abc"})
        with self.assertRaises(ConflictError):
            connectors.add_from_catalog("github", {"Authorization": "x"})
        with self.assertRaises(NotFoundError):
            connectors.add_from_catalog("nope")
        # Optional values may be left out.
        self.assertEqual(connectors.add_from_catalog("context7")["header_names"], [])

    def test_import_claude_style_json(self):
        text = json.dumps({"mcpServers": {
            "files": {"command": "npx", "args": ["-y", "@scope/server", "/tmp"], "env": {"TOKEN": "abc"}},
            "remote-one": {"url": "https://mcp.example.com/mcp", "headers": {"X-Key": "k"}},
        }})
        added = connectors.import_json(text)
        self.assertEqual(sorted(c["name"] for c in added), ["files", "remote-one"])
        files = next(c for c in added if c["name"] == "files")
        self.assertEqual(files["command"], ["npx", "-y", "@scope/server", "/tmp"])

    def test_import_is_all_or_nothing(self):
        text = json.dumps({"mcpServers": {"good": {"command": "x"}, "bad": {"url": "ftp://x"}}})
        with self.assertRaises(ValidationError):
            connectors.import_json(text)
        self.assertEqual(connectors.list_connectors(), [])
        for bad in ("not json", "[]", '{"mcpServers": {}}', '{"mcpServers": {"x": {}}}'):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                connectors.import_json(bad)

    def test_update_and_delete(self):
        c = connectors.create(name="t", kind="local", command="x", env={"A": "1"})
        c = connectors.update(c["id"], {"use_in_code": False, "env": {"B": "2"}})
        self.assertFalse(c["use_in_code"])
        self.assertEqual(c["env_names"], ["B"])
        self.assertEqual(connectors.agent_mcp_config(), {})  # not used in Code
        with self.assertRaises(ValidationError):
            connectors.update(c["id"], {"enabled": "yes"})
        with self.assertRaises(ValidationError):
            connectors.update(c["id"], {"headers": {"X": "y"}})  # local has no headers
        connectors.delete(c["id"])
        with self.assertRaises(NotFoundError):
            connectors.delete(c["id"])

    def test_agent_config(self):
        connectors.create(name="local-one", kind="local", command=["uvx", "srv"], env={"K": "v"})
        off = connectors.create(name="off", kind="local", command="x")
        connectors.update(off["id"], {"enabled": False})
        servers = connectors.agent_mcp_config()["servers"]
        self.assertEqual(servers, {"local-one": {"type": "local", "command": ["uvx", "srv"], "environment": {"K": "v"}}})


class AgentConfigTests(Base):
    def test_model_config_includes_mcp(self):
        from app import llm
        from app.services.coding_agent import config
        connectors.create(name="srv", kind="remote", url="https://e.com/mcp")
        with mock.patch.dict(os.environ, {"LLM_API_KEY": "k", "LLM_MODEL": "m"}):
            llm.settings.cache_clear()
            cfg = config.model_config()
        llm.settings.cache_clear()
        self.assertEqual(cfg["mcp"]["servers"]["srv"], {"type": "remote", "url": "https://e.com/mcp", "oauth": False})


class RouteTests(Base):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router import connectors as routes

        patcher = mock.patch.object(routes, "_apply_to_agent", lambda: True)
        patcher.start()
        self.addCleanup(patcher.stop)
        app = FastAPI()
        register_error_handlers(app)
        app.include_router(routes.connectors_router, prefix="/api")
        self.client = TestClient(app)

    def test_flow(self):
        self.assertTrue(len(self.client.get("/api/connectors/catalog").json()["catalog"]) >= 10)
        r = self.client.post("/api/connectors", json={"name": "x", "kind": "local", "command": "uvx srv",
                                                      "env": {"KEY": "secret"}})
        self.assertEqual(r.status_code, 201)
        cid = r.json()["id"]
        self.assertNotIn("secret", self.client.get("/api/connectors").text)
        r = self.client.post("/api/connectors/import", json={"json": '{"mcpServers": {"y": {"url": "https://e.com"}}}'})
        self.assertEqual(r.status_code, 201)
        r = self.client.post("/api/connectors/catalog/time", json={"values": {}})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.client.put(f"/api/connectors/{cid}", json={"enabled": False}).json()["enabled"], False)
        self.assertEqual(self.client.delete(f"/api/connectors/{cid}").status_code, 204)
        self.assertEqual(self.client.post("/api/connectors", json={"name": "z", "kind": "remote",
                                                                  "url": "file:///x"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
