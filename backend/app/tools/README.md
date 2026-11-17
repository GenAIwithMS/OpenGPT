# Tools

Things the chat can use besides the model itself.

## Chat tools

Offered to the chat model on every message (`all_tools` in
`app/services/chatbot.py`); the model decides when to call them.

| Tool | File | Needs | Notes |
|---|---|---|---|
| `Search` | `search.py`, `parallel_search.py` | `PARALLEL_API_KEY`, else `BRAVE_API_KEY` | Results carry sources that become citations (`services/citations.py`) |
| `Weather` | `weather.py` | `WEATHER_API_KEY` (OpenWeather) | |
| `Stock_price` | `stock_price.py` | `STOCK_API_KEY` (Alpha Vantage) | |
| `Calculator` | `calculator.py` | nothing | One operation on two numbers |

Other tools are added per message when they apply: `Knowledge`
(`services/knowledge.py`), `Skill` (`services/skills.py`) and connector tools
(`services/mcp_tools.py`). A tool that raises returns a short error the model
can act on instead of failing the reply. To add one, see
[Add a chat tool](../../../docs/guides/add-a-chat-tool.md).

## Workflows

Started from the tools menu in the chat, not by the model, because they run
for a long time and stream their own progress:

| Folder | Does | Read |
|---|---|---|
| `deep_research/` | Plans, searches in rounds and writes a cited report | [README](deep_research/README.md) |
| `blogs/` | Researches and writes a blog post, with optional images | [README](blogs/README.md) |
