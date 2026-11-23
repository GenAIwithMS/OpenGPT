"""The browser engine launcher: API per provider, the model configuration and the pipe."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests import _helpers  # noqa: F401  (test settings)

from app import llm  # noqa: E402
from app.services import browser_engine as be  # noqa: E402


def settings(**overrides):
    base = {"provider": "openai", "api_key": "sk-test", "base_url": "https://compat.example/v1",
            "model": "chat-m", "browser_build_model": "build-m", "browser_review_model": "review-m"}
    return {**base, **overrides}


class ConfigTests(unittest.TestCase):
    def test_api_per_provider(self):
        self.assertEqual(be.api_for("openai", None), "responses")
        self.assertEqual(be.api_for("openai", "https://api.openai.com/v1"), "responses")
        self.assertEqual(be.api_for("openai", "http://127.0.0.1:11434/v1"), "chat")
        self.assertEqual(be.api_for("anthropic", None), "anthropic")

    def test_config_from_the_active_provider(self):
        with mock.patch.object(llm, "settings", return_value=settings()), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BROWSER_CONTEXT_TOKENS", None)
            os.environ.pop("BROWSER_REASONING_EFFORT", None)
            self.assertEqual(be.config(), {"api": "chat", "apiKey": "sk-test", "baseUrl": "https://compat.example/v1",
                                           "buildModel": "build-m", "reviewModel": "review-m"})
        local = settings(api_key="not-needed", base_url="http://127.0.0.1:8080/v1")
        with mock.patch.object(llm, "settings", return_value=local), \
                mock.patch.dict(os.environ, {"BROWSER_CONTEXT_TOKENS": "32000", "BROWSER_REASONING_EFFORT": "true"}):
            out = be.config()
        self.assertNotIn("apiKey", out)
        self.assertEqual((out["contextTokens"], out["reasoningEffort"]), (32000, True))

    def test_review_model_defaults_to_the_build_model(self):
        env = {"BROWSER_BUILD_MODEL": "b", "BROWSER_REVIEW_MODEL": ""}
        with mock.patch.dict(os.environ, env):
            cfg = llm.env_settings()
        self.assertEqual((cfg["browser_build_model"], cfg["browser_review_model"]), ("b", "b"))


class NodeTests(unittest.TestCase):
    def test_missing_or_wrong_node(self):
        with mock.patch.object(llm, "env", return_value=None), mock.patch.object(be.shutil, "which", return_value=None):
            with self.assertRaises(be.EngineUnavailable) as e:
                be.node_path()
        self.assertIn("Node.js 24", str(e.exception))
        old = subprocess.CompletedProcess([], 0, stdout="v22.1.0\n")
        with mock.patch.object(llm, "env", return_value="/x/node"), mock.patch.object(be.subprocess, "run", return_value=old):
            with self.assertRaises(be.EngineUnavailable) as e:
                be.node_path()
        self.assertIn("v22.1.0", str(e.exception))
        new = subprocess.CompletedProcess([], 0, stdout="v24.22.3\n")
        with mock.patch.object(llm, "env", return_value="/x/node"), mock.patch.object(be.subprocess, "run", return_value=new):
            self.assertEqual(be.node_path(), "/x/node")

    def test_not_built(self):
        with mock.patch.object(be, "node_path", return_value="node"), mock.patch.object(be, "CLI", Path("/nowhere/cli.js")):
            with self.assertRaises(be.EngineUnavailable) as e:
                be.check()
        self.assertIn("pnpm build", str(e.exception))


class PipeTests(unittest.TestCase):
    def test_configuration_goes_on_a_pipe_not_the_environment(self):
        # A stand-in for the engine that prints what it was given.
        script = textwrap.dedent("""
            import json, os, sys
            fd = int(os.environ["BROWSER_ENGINE_CONFIG_FD"])
            config = json.loads(os.read(fd, 65536))
            print(json.dumps({"config": config, "argv": sys.argv[1:],
                              "openai_key_in_env": "OPENAI_API_KEY" in os.environ}))
        """)
        with tempfile.TemporaryDirectory() as folder:
            entry = Path(folder) / "engine.py"
            entry.write_text(script)
            with mock.patch.object(be, "check"), mock.patch.object(be, "node_path", return_value=sys.executable), \
                    mock.patch.object(llm, "settings", return_value=settings()), \
                    mock.patch.dict(os.environ, {"OPENAI_API_KEY": "should-not-pass"}):
                process = be.start(entry, ["mint", "--url", "https://example.com"], stdout=subprocess.PIPE, text=True)
                out, _ = process.communicate(timeout=30)
        seen = json.loads(out)
        self.assertEqual(seen["config"]["apiKey"], "sk-test")
        self.assertEqual(seen["argv"], ["mint", "--url", "https://example.com"])
        self.assertFalse(seen["openai_key_in_env"])


if __name__ == "__main__":
    unittest.main()
