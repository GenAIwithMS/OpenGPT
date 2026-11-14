import os
import unittest
from unittest import mock

from tests import _helpers  # noqa: F401
from app import llm


def settings_with(**env):
    clean = {k: v for k, v in os.environ.items() if not k.startswith("LLM_")}
    clean.update(env)
    with mock.patch.dict(os.environ, clean, clear=True):
        llm.settings.cache_clear()
        try:
            return llm.settings()
        finally:
            llm.settings.cache_clear()


class LLMSettingsTests(unittest.TestCase):
    def tearDown(self):
        llm.settings.cache_clear()

    def test_openai_compatible(self):
        s = settings_with(LLM_API_KEY="k", LLM_BASE_URL="http://host/v1", LLM_MODEL="m")
        self.assertEqual((s["provider"], s["base_url"], s["model"]), ("openai", "http://host/v1", "m"))
        self.assertEqual(s["small_model"], "m")

    def test_anthropic(self):
        s = settings_with(LLM_PROVIDER="anthropic", LLM_API_KEY="k", LLM_MODEL="m")
        self.assertEqual(s["provider"], "anthropic")

    def test_self_hosted_without_key(self):
        s = settings_with(LLM_BASE_URL="http://localhost:1234/v1", LLM_MODEL="m")
        self.assertEqual(s["api_key"], "not-needed")

    def test_missing_settings_are_reported(self):
        with self.assertRaises(llm.LLMConfigError):
            settings_with(LLM_MODEL="m")
        with self.assertRaises(llm.LLMConfigError):
            settings_with(LLM_API_KEY="k")
        with self.assertRaises(llm.LLMConfigError):
            settings_with(LLM_PROVIDER="other", LLM_API_KEY="k", LLM_MODEL="m")

    def test_placeholders_count_as_unset(self):
        with mock.patch.dict(os.environ, {"X_KEY": "your_api_key_here", "Y_KEY": "google_api_key"}):
            self.assertIsNone(llm.env("X_KEY"))
            self.assertIsNone(llm.env("Y_KEY"))

    def test_lazy_model_does_not_build_on_attribute_access(self):
        model = llm.LazyChatModel("model")
        self.assertTrue(callable(model.bind_tools))  # no settings needed yet

    def test_split_content(self):
        from langchain_core.messages import AIMessageChunk
        blocks = AIMessageChunk(content=[{"type": "thinking", "thinking": "t"}, {"type": "text", "text": "a"}])
        self.assertEqual(llm.split_content(blocks), ("a", "t"))
        self.assertEqual(llm.split_content(AIMessageChunk(content="a")), ("a", ""))


if __name__ == "__main__":
    unittest.main()
