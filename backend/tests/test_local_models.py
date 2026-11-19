"""Find local models: running servers, downloaded models, and the messages for each case."""
import json
import os
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from app.error_handlers import model_error_message, public_error  # noqa: E402
from app.exceptions import ValidationError  # noqa: E402
from app.services import local_models, providers  # noqa: E402


class FakeServer(BaseHTTPRequestHandler):
    status = 200
    models = ["llama3.1:8b"]

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"data": [{"id": m} for m in FakeServer.models]}).encode()
        self.send_response(FakeServer.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalModelsTests(unittest.TestCase):
    def setUp(self):
        FakeServer.status, FakeServer.models = 200, ["llama3.1:8b"]
        server = HTTPServer(("127.0.0.1", 0), FakeServer)
        self.running_port = server.server_port
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.home, ignore_errors=True))
        patches = [
            mock.patch.object(local_models, "_home", return_value=self.home),
            mock.patch.object(local_models.shutil, "which", return_value=None),
            mock.patch.dict(os.environ, {"HOST": "127.0.0.1", "OLLAMA_MODELS": "", "OLLAMA_HOST": "",
                                         "LLAMA_CACHE": "", "APPDATA": ""}),
            mock.patch.object(local_models, "_folders", side_effect=self._folders),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.ports = {s["preset"]: free_port() for s in local_models.SERVERS}
        port = mock.patch.object(local_models, "_port", side_effect=lambda s: self.ports[s["preset"]])
        port.start()
        self.addCleanup(port.stop)

    def _folders(self, preset):
        return {"ollama": [self.home / ".ollama" / "models"],
                "lmstudio": [self.home / ".lmstudio" / "models"],
                "llamacpp": [self.home / ".cache" / "llama.cpp"],
                "jan": [self.home / "jan" / "models"]}[preset]

    def add_ollama_model(self, namespace, model, tag, size):
        path = self.home / ".ollama" / "models" / "manifests" / "registry.ollama.ai" / namespace / model / tag
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"layers": [{"size": size}, {"size": 10}]}))

    def by_preset(self, result):
        return {s["preset"]: s for s in result["servers"]}

    def test_running_server_lists_its_models(self):
        self.ports["ollama"] = self.running_port
        found = self.by_preset(local_models.find())
        self.assertEqual(found["ollama"]["status"], "running")
        self.assertEqual(found["ollama"]["models"], ["llama3.1:8b"])
        self.assertEqual(found["ollama"]["base_url"], f"http://localhost:{self.running_port}/v1")
        self.assertNotIn("lmstudio", found)   # not running, nothing on disk, not installed

    def test_downloaded_but_not_running(self):
        self.add_ollama_model("library", "qwen2.5", "7b", 4000)
        self.add_ollama_model("someone", "coder", "latest", 2000)
        ollama = self.by_preset(local_models.find())["ollama"]
        self.assertEqual(ollama["status"], "stopped")
        self.assertEqual(ollama["downloaded"], [{"name": "qwen2.5:7b", "size": 4010},
                                                 {"name": "someone/coder:latest", "size": 2010}])
        self.assertIn("isn't running", ollama["message"])
        self.assertIn("qwen2.5:7b", ollama["message"])
        self.assertEqual(ollama["command"], "ollama serve")

    def test_lm_studio_and_llama_cpp_files(self):
        repo = self.home / ".lmstudio" / "models" / "pub" / "Model-GGUF"
        repo.mkdir(parents=True)
        (repo / "model-Q4.gguf").write_bytes(b"x" * 5)
        (repo / "mmproj-model.gguf").write_bytes(b"x")
        cache = self.home / ".cache" / "llama.cpp"
        cache.mkdir(parents=True)
        (cache / "big-00001-of-00002.gguf").write_bytes(b"x" * 3)
        (cache / "big-00002-of-00002.gguf").write_bytes(b"x" * 3)
        found = self.by_preset(local_models.find())
        self.assertEqual(found["lmstudio"]["downloaded"], [{"name": "pub/Model-GGUF", "size": 5}])
        self.assertEqual(found["llamacpp"]["downloaded"], [{"name": "big", "size": 6}])

    def test_running_but_empty_and_installed(self):
        FakeServer.models = []
        self.ports["lmstudio"] = self.running_port
        (self.home / ".ollama" / "models").mkdir(parents=True)   # installed, nothing downloaded
        found = self.by_preset(local_models.find())
        self.assertEqual(found["lmstudio"]["status"], "empty")
        self.assertEqual(found["lmstudio"]["command"], "lms get <model>")
        self.assertEqual(found["ollama"]["status"], "installed")

    def test_server_that_wants_a_key(self):
        FakeServer.status = 401
        self.ports["jan"] = self.running_port
        self.assertEqual(self.by_preset(local_models.find())["jan"]["status"], "needs_key")

    def test_no_disk_check_when_exposed(self):
        self.add_ollama_model("library", "qwen2.5", "7b", 4000)
        with mock.patch.dict(os.environ, {"HOST": "0.0.0.0"}):
            result = local_models.find()
            self.assertFalse(result["disk_checked"])
            self.assertEqual(result["servers"], [])
            self.assertNotIn("downloaded", local_models.unreachable_message(
                f"http://localhost:{self.ports['ollama']}/v1"))

    def test_test_button_explains_a_stopped_local_server(self):
        self.add_ollama_model("library", "qwen2.5", "7b", 4000)
        with self.assertRaises(ValidationError) as ctx:
            providers.test(preset="ollama", base_url=f"http://localhost:{self.ports['ollama']}/v1")
        self.assertIn("Ollama isn't running", ctx.exception.message)
        self.assertIn("1 model downloaded", ctx.exception.message)
        self.assertIsNone(local_models.unreachable_message("https://api.example.com/v1"))

    def test_presets_include_local_servers(self):
        local = {p["id"] for p in providers.PRESETS if p.get("local")}
        self.assertEqual(local, {"ollama", "lmstudio", "llamacpp", "jan"})


class ModelErrorTests(unittest.TestCase):
    def test_known_errors_get_a_specific_message(self):
        try:
            try:
                raise RuntimeError('registry.ollama.ai/library/tiny:1b does not support tools')
            except RuntimeError as e:
                raise Exception(f"Failed to stream message: {e}") from e
        except Exception as wrapped:
            self.assertIn("tool calling", model_error_message(wrapped))
        self.assertIn("context window", model_error_message(ValueError("exceeds maximum context length")))
        self.assertIn("start it", model_error_message(ConnectionError("[Errno 111] Connection refused")))

    def test_unknown_errors_stay_generic(self):
        self.assertIsNone(model_error_message(KeyError("secret-key-abc")))
        message = public_error("ref1", KeyError("secret-key-abc"))
        self.assertNotIn("secret", message)
        self.assertIn("Something went wrong", message)


if __name__ == "__main__":
    unittest.main()
