# Backend tests

```bash
python -m unittest discover -s tests -t .     # all (about a minute)
python -m unittest tests.test_skills          # one module
python -m unittest tests.test_skills.SkillsTests.test_upload_md_and_zip
```

Plain `unittest`; `pytest` also works (`requirements-dev.txt`).

## Ground rules

- **No MySQL, keys or network.** `_helpers.py` sets test values for the
  model settings and turns off tracing, rate limits and the coding agent.
  Call `_helpers.use_sqlite()` (module level and in `setUp`) for a fresh
  in-memory database with all tables.
- **Fake outside services** with a local `http.server` in a thread or
  `unittest.mock`; never call a real provider.
- **Don't touch `app/storage/`**: patch paths to a temporary directory.
- Test failure paths too: bad input, refused requests, timeouts.

## What's where

| Area | Tests | Fakes used |
|---|---|---|
| API routes, uploads, limits | `test_api.py` | |
| Chat graph input | `test_chat_node.py` | recording fake model |
| Checkpointer | `test_checkpointer.py` | |
| Citations | `test_citations.py` | |
| Calculator | `test_calculator.py` | |
| Model settings | `test_llm_settings.py` | |
| Providers, model menu, Auto | `test_providers.py`, `test_model_router.py` | fake OpenAI-compatible server |
| Settings, personalization, knowledge | `test_settings.py`, `test_personalization.py` | |
| Connectors, sign-in | `test_connectors.py`, `test_connector_oauth.py` | fake MCP + OAuth server, fake GitHub device flow |
| Connector tools in chat, approvals | `test_mcp_tools.py` | `fixtures/notes_mcp.py` (a small real MCP server) |
| Skills | `test_skills.py` | in-memory zip and tar archives |
| Coding agent | `test_coding_agent.py`, `test_code_*.py` | fake agent server; never starts Bun |
