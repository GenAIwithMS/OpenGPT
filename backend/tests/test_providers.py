"""Model providers (Settings > Developer): add, test, choose, and llm settings follow."""
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from app import llm, secret_box  # noqa: E402
from app.exceptions import NotFoundError, ValidationError  # noqa: E402
from app.services import providers  # noqa: E402
from app.services.coding_agent import config as agent_config  # noqa: E402


class FakeProvider(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        FakeProvider.seen.append((self.path, dict(self.headers)))
        if self.headers.get("Authorization") not in ("Bearer good-key", None) and "x-api-key" not in self.headers:
            self.send_response(401)
            self.end_headers()
            return
        body = json.dumps({"data": [{"id": "big-model"}, {"id": "small-model"}]}).encode()
        self.send_response(200 if self.path.endswith("models") or "models?" in self.path else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


ENV = {"LLM_PROVIDER": "openai", "LLM_API_KEY": "env-key", "LLM_BASE_URL": "", "LLM_MODEL": "env-model",
       "LLM_SMALL_MODEL": "", "BLOG_MODEL": "", "RESEARCH_MODEL": "", "CODING_AGENT_MODEL": "",
       "SETTINGS_SECRET": "t"}


class ProvidersTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        env = mock.patch.dict(os.environ, ENV)
        env.start()
        self.addCleanup(env.stop)
        secret_box._reset_for_tests()
        restart = mock.patch("app.services.coding_agent.process.agent.restart")
        self.restart = restart.start()
        self.addCleanup(restart.stop)
        llm.reload()
        self.addCleanup(llm.reload)
        server = HTTPServer(("127.0.0.1", 0), FakeProvider)
        self.base = f"http://127.0.0.1:{server.server_port}/v1"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def test_env_is_the_default(self):
        info = providers.overview()
        self.assertEqual(info["active"], "env")
        self.assertEqual(info["env"]["model"], "env-model")
        self.assertNotIn("env-key", json.dumps(info))
        self.assertEqual(llm.settings()["model"], "env-model")

    def test_add_test_and_switch(self):
        item = providers.create("custom", name="Local box", base_url=self.base, api_key="good-key",
                                model="big-model", kind="openai")
        self.assertTrue(item["has_key"])
        self.assertNotIn("good-key", json.dumps(providers.overview()))
        self.assertEqual(providers.test(provider_id=item["id"])["models"], ["big-model", "small-model"])
        with self.assertRaises(ValidationError):
            providers.test(preset="custom", base_url=self.base, api_key="bad-key")

        providers.set_active(item["id"], {"small_model": "small-model"})
        cfg = llm.settings()
        self.assertEqual((cfg["model"], cfg["small_model"], cfg["research_model"]),
                         ("big-model", "small-model", "big-model"))
        self.assertEqual((cfg["base_url"], cfg["api_key"]), (self.base, "good-key"))
        self.assertEqual(agent_config.model_config()["model"], "opengpt/big-model")
        self.restart.assert_called()

        providers.delete(item["id"])   # the active one: back to .env
        self.assertEqual(providers.overview()["active"], "env")
        self.assertEqual(llm.settings()["model"], "env-model")

    def test_roles_on_the_env_provider(self):
        providers.set_active("env", {"coding_model": "coder"})
        self.assertEqual(llm.settings()["coding_model"], "coder")
        self.assertEqual(agent_config.model_id(), "coder")
        self.assertEqual(llm.settings()["model"], "env-model")

    def test_validation(self):
        with self.assertRaises(ValidationError):
            providers.create("openai")                       # no key
        with self.assertRaises(ValidationError):
            providers.create("custom", base_url="ftp://x")
        with self.assertRaises(ValidationError):
            providers.create("nope", api_key="k")
        ollama = providers.create("ollama")                   # local: no key needed
        self.assertEqual(ollama["base_url"], "http://localhost:11434/v1")
        with self.assertRaises(ValidationError):
            providers.set_active(ollama["id"], {})            # no model chosen
        with self.assertRaises(NotFoundError):
            providers.set_active("missing", {"model": "m"})
        updated = providers.update(ollama["id"], {"model": "llama3", "api_key": ""})
        self.assertEqual((updated["model"], updated["has_key"]), ("llama3", False))

    def test_anthropic_model_list(self):
        FakeProvider.seen.clear()
        base = self.base.removesuffix("/v1")
        providers.test(preset="custom", kind="anthropic", base_url=base, api_key="ak")
        path, headers = FakeProvider.seen[-1]
        self.assertTrue(path.startswith("/v1/models"))
        self.assertEqual((headers.get("x-api-key"), headers.get("anthropic-version")), ("ak", "2023-06-01"))


if __name__ == "__main__":
    unittest.main()
