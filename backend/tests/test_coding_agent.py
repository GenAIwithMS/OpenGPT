"""Coding agent settings and process manager (no real agent is started)."""
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from tests import _helpers  # noqa: F401
from app import llm
from app.services.coding_agent import config, process


def llm_env(**env):
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "CODING_AGENT_", "HOST"))}
    clean.update(env)
    return mock.patch.dict(os.environ, clean, clear=True)


class ModelConfigTests(unittest.TestCase):
    def tearDown(self):
        llm.settings.cache_clear()

    def build(self, **env):
        # No network: the provider's model list is unavailable, so only the
        # models chosen for each job are offered.
        with llm_env(**env), mock.patch("app.services.providers.test", side_effect=RuntimeError("offline")):
            llm.settings.cache_clear()
            from app.services import providers
            providers.forget_models()
            return config.model_config()

    def test_openai_compatible_endpoint(self):
        cfg = self.build(LLM_API_KEY="k", LLM_BASE_URL="http://host/v1", LLM_MODEL="m")
        provider = cfg["providers"]["opengpt"]
        self.assertEqual(provider["package"], "@opencode/ai/providers/openai-compatible")
        self.assertEqual(provider["settings"], {"baseURL": "http://host/v1", "apiKey": "k"})
        self.assertEqual(list(provider["models"]), ["m"])
        self.assertEqual(cfg["model"], "opengpt/m")
        self.assertEqual((cfg["share"], cfg["update"]), ("disabled", "disable"))

    def test_anthropic_gets_default_url(self):
        cfg = self.build(LLM_PROVIDER="anthropic", LLM_API_KEY="k", LLM_MODEL="m")
        provider = cfg["providers"]["opengpt"]
        self.assertEqual(provider["package"], "@opencode/ai/providers/anthropic-compatible")
        self.assertEqual(provider["settings"]["baseURL"], "https://api.anthropic.com/v1")

    def test_coding_agent_model_override(self):
        cfg = self.build(LLM_API_KEY="k", LLM_MODEL="chat", CODING_AGENT_MODEL="coder")
        self.assertEqual(cfg["model"], "opengpt/coder")
        # The coding model is the default; the chat model is offered in the menu too.
        self.assertEqual(list(cfg["providers"]["opengpt"]["models"]), ["coder", "chat"])

    def test_self_hosted_without_key(self):
        cfg = self.build(LLM_BASE_URL="http://localhost:11434/v1", LLM_MODEL="m")
        self.assertNotIn("apiKey", cfg["providers"]["opengpt"]["settings"])


class SettingsTests(unittest.TestCase):
    def test_on_locally_off_when_exposed(self):
        with llm_env(HOST="127.0.0.1"):
            self.assertTrue(config.enabled())
        with llm_env(HOST="0.0.0.0"):
            self.assertFalse(config.enabled())
        with llm_env(HOST="0.0.0.0", CODING_AGENT_ENABLED="true"):
            self.assertTrue(config.enabled())
        with llm_env(HOST="127.0.0.1", CODING_AGENT_ENABLED="false"):
            self.assertFalse(config.enabled())


class ChildEnvTests(unittest.TestCase):
    def test_backend_secrets_are_not_passed(self):
        secrets = {
            "MYSQL_PASSWORD": "db-secret",
            "LLM_API_KEY": "llm-secret",
            "TAVILY_API_KEY": "t",
            "API_TOKEN": "tok",
        }
        with mock.patch.dict(os.environ, {**secrets, "PATH": "/bin", "HOME": "/h", "LC_ALL": "C"}):
            env = process.child_env("pw", "{}")
        for name in secrets:
            self.assertNotIn(name, env)
        self.assertEqual((env["PATH"], env["HOME"], env["LC_ALL"]), ("/bin", "/h", "C"))
        self.assertEqual(env["OPENGPT_PASSWORD"], "pw")
        self.assertEqual(env["OPENGPT_DISABLE_FREE_MODELS"], "1")
        self.assertEqual(env["OPENGPT_DISABLE_PROJECT_CONFIG"], "1")
        self.assertEqual(env["OPENGPT_STRICT_LOCATION"], "1")


class FakeAgent(BaseHTTPRequestHandler):
    provider = "opengpt"

    def do_GET(self):
        if self.headers.get("Authorization") is None:
            self.send_response(401)
            self.end_headers()
            return
        body = {"/api/info": {"version": "test"},
                "/api/model/default": {"data": {"providerID": self.provider, "id": "m"}}}.get(self.path)
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body or {}).encode())

    def log_message(self, *args):
        pass


class ProcessTests(unittest.TestCase):
    def serve(self, provider="opengpt"):
        handler = type("Handler", (FakeAgent,), {"provider": provider})
        server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    def test_disabled(self):
        agent = process.CodingAgent()
        with llm_env(CODING_AGENT_ENABLED="false"):
            agent.start()
        self.assertEqual(agent.status.state, process.DISABLED)
        self.assertFalse(agent.status.public()["available"])

    def test_external_agent_needs_password(self):
        agent = process.CodingAgent()
        with llm_env(CODING_AGENT_ENABLED="true", CODING_AGENT_URL="http://127.0.0.1:1"):
            agent.start()
        self.assertEqual(agent.status.state, process.UNAVAILABLE)

    def test_external_agent_ready(self):
        agent = process.CodingAgent()
        agent._password = "pw"
        agent._wait_ready(self.serve(), None)
        self.assertEqual(agent.status.state, process.RUNNING)
        public = agent.status.public()
        self.assertEqual(public["model"], "m")
        self.assertNotIn("url", public)  # never exposed to the browser

    def test_refuses_another_default_model(self):
        agent = process.CodingAgent()
        agent._password = "pw"
        agent._wait_ready(self.serve(provider="someone-else"), None)
        self.assertEqual(agent.status.state, process.UNAVAILABLE)

    def test_missing_bun_is_reported(self):
        agent = process.CodingAgent()
        with llm_env(CODING_AGENT_ENABLED="true", LLM_API_KEY="k", LLM_MODEL="m"), \
                mock.patch.object(process, "find_bun", return_value=None):
            agent.start()
        self.assertEqual(agent.status.state, process.UNAVAILABLE)
        self.assertIn("Bun", agent.status.detail)


class StatusRouteTests(unittest.TestCase):
    def client(self):
        from fastapi import Depends, FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.code import code_router
        from app.security import require_api_token

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(code_router, prefix="/api", dependencies=[Depends(require_api_token)])
        return TestClient(app)

    def test_status_reports_without_secrets(self):
        r = self.client().get("/api/code/status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.json()), {"state", "available", "detail", "model"})
        self.assertFalse(r.json()["available"])

    def test_status_needs_the_api_token(self):
        with mock.patch.dict(os.environ, {"API_TOKEN": "secret"}):
            client = self.client()
            self.assertEqual(client.get("/api/code/status").status_code, 401)
            ok = client.get("/api/code/status", headers={"Authorization": "Bearer secret"})
            self.assertEqual(ok.status_code, 200)


if __name__ == "__main__":
    unittest.main()


class SpawnThreadTests(unittest.TestCase):
    """The agent must outlive the (short-lived) thread that restarts it."""

    @unittest.skipUnless(sys.platform.startswith("linux"), "PR_SET_PDEATHSIG is Linux-only")
    def test_child_started_from_an_ended_thread_keeps_running(self):
        from app.services.coding_agent import process as agent_process

        box = {}

        def restart_like():
            box["p"] = agent_process.spawn(["sleep", "30"], preexec_fn=agent_process._die_with_parent)

        t = threading.Thread(target=restart_like)
        t.start()
        t.join()
        time.sleep(0.5)
        try:
            self.assertIsNone(box["p"].poll(), "the agent was stopped when the thread that started it ended")
        finally:
            box["p"].kill()
            box["p"].wait()

    def test_start_errors_reach_the_caller(self):
        from app.services.coding_agent import process as agent_process

        with self.assertRaises(OSError):
            agent_process.spawn(["/nonexistent/program"])
