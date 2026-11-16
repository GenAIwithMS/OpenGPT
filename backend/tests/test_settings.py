"""App settings: defaults, partial updates, validation, routes."""
import unittest

from tests import _helpers

_helpers.use_sqlite()

from app.database.config import DatabaseConfig  # noqa: E402
from app.database.models import AppSetting  # noqa: E402
from app.exceptions import ValidationError  # noqa: E402
from app.services import settings  # noqa: E402


class SettingsTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()

    def test_defaults(self):
        s = settings.get_all()
        self.assertEqual(s["display_name"], "Muhammad")
        self.assertEqual(s["general"], {"temporary_by_default": False,
                                        "notify_on_finish": False, "sound_on_finish": False})
        self.assertEqual(s["profile"]["nickname"], "")

    def test_partial_update_keeps_other_fields(self):
        settings.update({"general": {"temporary_by_default": True}})
        s = settings.update({"general": {"sound_on_finish": True}, "profile": {"nickname": " Ali "}})
        self.assertTrue(s["general"]["temporary_by_default"])
        self.assertTrue(s["general"]["sound_on_finish"])
        self.assertEqual(s["display_name"], "Ali")

    def test_validation(self):
        bad = [
            {},
            {"unknown": {}},
            {"general": {"sound_on_finish": "loud"}},
            {"general": {"send_key": "enter"}},  # removed setting
            {"general": {"made_up": True}},
            {"profile": {"nickname": "x" * 51}},
            {"general": "not an object"},
        ]
        for changes in bad:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                settings.update(changes)
        self.assertFalse(settings.get_all()["general"]["sound_on_finish"])

    def test_old_or_broken_stored_values_fall_back(self):
        with DatabaseConfig.get_session_factory()() as db:
            # send_key was removed; a value saved before is ignored.
            db.add(AppSetting(key="general", value='{"send_key": "ctrl_enter", "sound_on_finish": true}'))
            db.add(AppSetting(key="profile", value="not json"))
            db.commit()
        s = settings.get_all()
        self.assertNotIn("send_key", s["general"])
        self.assertTrue(s["general"]["sound_on_finish"])
        self.assertEqual(s["profile"]["nickname"], "")


class RouteTests(unittest.TestCase):
    def setUp(self):
        _helpers.use_sqlite()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from app.error_handlers import register_error_handlers
        from app.router.settings import settings_router

        app = FastAPI()
        register_error_handlers(app)
        app.include_router(settings_router, prefix="/api")
        self.client = TestClient(app)

    def test_get_and_put(self):
        self.assertEqual(self.client.get("/api/settings").json()["display_name"], "Muhammad")
        r = self.client.put("/api/settings", json={"general": {"temporary_by_default": True}})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["general"]["temporary_by_default"])
        self.assertEqual(self.client.put("/api/settings", json={"general": {"sound_on_finish": "x"}}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
