"""The built frontend served by the backend (FRONTEND_DIST, used by the Docker image)."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import _helpers

_helpers.use_sqlite()

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import _serve_frontend  # noqa: E402
from app.error_handlers import register_error_handlers  # noqa: E402


class FrontendServingTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.dist = self.base / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "index.html").write_text("<html>app</html>")
        (self.dist / "assets" / "app.js").write_text("console.log(1)")
        (self.base / "secret.txt").write_text("outside")

    def client(self, dist):
        app = FastAPI()
        register_error_handlers(app)

        @app.get("/api/ping")
        def ping():
            return {"ok": True}

        with mock.patch.dict(os.environ, {"FRONTEND_DIST": str(dist)}):
            _serve_frontend(app)
        return TestClient(app)

    def test_files_routes_and_api(self):
        c = self.client(self.dist)
        self.assertEqual(c.get("/").text, "<html>app</html>")
        self.assertEqual(c.get("/assets/app.js").text, "console.log(1)")
        self.assertEqual(c.get("/c/1234").text, "<html>app</html>")   # a frontend route
        self.assertEqual(c.get("/api/ping").json(), {"ok": True})
        self.assertEqual(c.get("/api/nothing").status_code, 404)

    def test_no_files_outside_the_folder(self):
        c = self.client(self.dist)
        for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"):
            self.assertNotIn("outside", c.get(path).text)

    def test_off_without_a_built_frontend(self):
        c = self.client(self.base / "missing")
        self.assertEqual(c.get("/").status_code, 404)


if __name__ == "__main__":
    unittest.main()
