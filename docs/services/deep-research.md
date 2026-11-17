# Deep research

A multi-step research agent that writes a cited report. It runs when the user
picks **Deep research** in the tools menu; the chat model never starts it on
its own, because it takes minutes.

## How it works

The graph is in `app/tools/deep_research/deep_researcher.py`:

1. **Research brief**: the question and recent chat history become a brief.
2. **Supervisor**: plans the work and starts researchers (up to
   `MAX_CONCURRENT_RESEARCH_UNITS` at once), for up to
   `DEEP_RESEARCH_MAX_ITERATIONS` rounds.
3. **Researchers**: each searches the web (`SEARCH_API`: Parallel, Tavily or
   DuckDuckGo; up to `DEEP_RESEARCH_MAX_TOOL_CALLS` searches) and compresses
   what it found.
4. **Final report**: written by the research model (`RESEARCH_MODEL` or the
   per-job model in Settings > Developer), streamed to the chat.

`ChatService._stream_deep_research` (`app/services/chat.py`) sends progress
as `research` events (planning, searches, sources) for the activity panel,
then the report, and saves both in the thread. The report can be edited later
(`PUT /api/threads/{id}/reports/{index}`).

## Settings

See [configuration](../configuration.md#deep-research). The values the chat
passes (`DEEP_RESEARCH_MAX_ITERATIONS`, `DEEP_RESEARCH_MAX_TOOL_CALLS`) take
precedence over the module's own defaults.

## Pitfalls

- Clarifying questions are turned off in chat (`allow_clarification: False`);
  the brief works with what the user wrote.
- Long runs use many tokens. Lower the limits for small rate limits.
