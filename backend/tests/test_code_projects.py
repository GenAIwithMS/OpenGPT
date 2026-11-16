"""Coding agent project folders: name and path checks, listing, creating."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from tests import _helpers  # noqa: F401
from app.exceptions import ConflictError, NotFoundError, ValidationError
from app.services.coding_agent import projects


class ProjectsTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.root = self.tmp / "projects"
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        patcher = mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": str(self.root)})
        patcher.start()
        self.addCleanup(patcher.stop)


class NameTests(ProjectsTestCase):
    def test_valid_names(self):
        for name in ["app", "my-app", "My App 2", "site.v2", "a_b", "7up"]:
            self.assertEqual(projects.validate_name(f"  {name} "), name)

    def test_rejected_names(self):
        bad = [
            "", "   ", "..", ".", "../x", "x/..", "a/b", "a\\b", "/etc", "~", "~/x",
            ".hidden", "-flag", "trailing.", "x..y", "a\x00b", "a\nb", "con", "NUL.txt",
            "x" * 65, "C:", "näme",
        ]
        for name in bad:
            with self.subTest(name=name), self.assertRaises(ValidationError):
                projects.validate_name(name)


class PathTests(ProjectsTestCase):
    def test_root_is_created(self):
        self.assertFalse(self.root.exists())
        self.assertEqual(projects.root(), self.root)
        self.assertTrue(self.root.is_dir())

    def test_existing_project(self):
        projects.create_project("app")
        self.assertEqual(projects.project_path("app"), self.root / "app")

    def test_missing_project(self):
        projects.root()
        with self.assertRaises(NotFoundError):
            projects.project_path("nope")

    def test_symlink_out_of_root_is_refused(self):
        projects.root()
        (self.root / "escape").symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(NotFoundError):
            projects.project_path("escape")
        self.assertEqual(projects.list_projects(), [])

    def test_symlink_to_a_file_or_loop_is_refused(self):
        projects.root()
        (self.outside / "file.txt").write_text("x")
        (self.root / "file").symlink_to(self.outside / "file.txt")
        (self.root / "loop").symlink_to(self.root / "loop")
        for name in ("file", "loop"):
            with self.subTest(name=name), self.assertRaises(NotFoundError):
                projects.project_path(name)
        self.assertEqual(projects.list_projects(), [])

    def test_symlinked_root_is_followed_once(self):
        real = self.tmp / "real-root"
        (real / "app").mkdir(parents=True)
        link = self.tmp / "link-root"
        link.symlink_to(real, target_is_directory=True)
        with mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": str(link)}):
            self.assertEqual(projects.project_path("app"), real / "app")

    def test_home_in_root_setting(self):
        with mock.patch.dict(os.environ, {"CODE_PROJECTS_ROOT": "~/x", "HOME": str(self.tmp)}):
            self.assertEqual(projects.root(), self.tmp / "x")


class ListAndCreateTests(ProjectsTestCase):
    def test_list_skips_files_hidden_and_invalid(self):
        root = projects.root()
        (root / "notes.txt").write_text("x")
        (root / ".git").mkdir()
        (root / "bad..name").mkdir()
        projects.create_project("app")
        self.assertEqual([p["name"] for p in projects.list_projects()], ["app"])

    def test_list_newest_first(self):
        projects.create_project("old")
        past = time.time() - 3600
        os.utime(self.root / "old", (past, past))
        projects.create_project("new")
        self.assertEqual([p["name"] for p in projects.list_projects()], ["new", "old"])

    def test_create_conflicts(self):
        projects.create_project("app")
        for name in ("app", "APP"):
            with self.subTest(name=name), self.assertRaises(ConflictError):
                projects.create_project(name)

    def test_create_refuses_existing_symlink_name(self):
        projects.root()
        (self.root / "link").symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(ConflictError):
            projects.create_project("link")
        self.assertEqual(list(self.outside.iterdir()), [])


class RouteTests(ProjectsTestCase):
    def setUp(self):
        super().setUp()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.code import code_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(code_router, prefix="/api")
        self.client = TestClient(app)

    def test_create_and_list(self):
        r = self.client.post("/api/code/projects", json={"name": "my-app"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["name"], "my-app")
        listed = self.client.get("/api/code/projects").json()["projects"]
        self.assertEqual([p["name"] for p in listed], ["my-app"])

    def test_errors(self):
        self.client.post("/api/code/projects", json={"name": "app"})
        self.assertEqual(self.client.post("/api/code/projects", json={"name": "app"}).status_code, 409)
        self.assertEqual(self.client.post("/api/code/projects", json={"name": "../x"}).status_code, 422)
        self.assertEqual(self.client.post("/api/code/projects", json={"name": "x" * 65}).status_code, 422)
        self.assertEqual(self.client.post("/api/code/projects", json={}).status_code, 422)
        self.assertFalse((self.tmp / "x").exists())


if __name__ == "__main__":
    unittest.main()
