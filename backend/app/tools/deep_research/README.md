# Deep research

A LangGraph agent that turns a question into a cited report. It runs when the
user picks Deep research in the chat's tools menu
(`ChatService._stream_deep_research` in `app/services/chat.py`). Overview and
settings: [docs/services/deep-research.md](../../../../docs/services/deep-research.md).

## Graph

```
START ─► clarify_with_user ─► write_research_brief ─► research_supervisor ─► final_report_generation ─► END
                                                         │
                                  supervisor ◄──► supervisor_tools
                                                   │  ConductResearch (one per topic, in parallel)
                                                   ▼
                                  researcher ◄──► researcher_tools ─► compress_research
                                     (web search, think_tool)
```

- **clarify_with_user**: off in OpenGPT (`allow_clarification: False`).
- **write_research_brief**: the question and recent chat become a brief.
- **supervisor**: splits the brief into topics and starts researchers
  (`ConductResearch`), up to `max_concurrent_research_units` at once and
  `max_researcher_iterations` rounds; ends with `ResearchComplete`.
- **researcher**: searches (up to `max_react_tool_calls`), reflects with
  `think_tool`, then **compress_research** condenses its findings.
- **final_report_generation**: writes the report from all findings.

## Files

| File | Owns |
|---|---|
| `deep_researcher.py` | The graphs and nodes above; progress events; model setup with retries on rate limits |
| `state.py` | Graph states and the structured outputs (`ConductResearch`, `ResearchQuestion`, ...) |
| `configuration.py` | `Configuration`: limits and search API, from the run config, then environment, then defaults |
| `prompts.py` | All prompts |
| `utils.py` | Search tool selection, Tavily search, page summaries, `think_tool`, token-limit detection |
| `parallel_search.py`, `duckduckgo_search.py` | The other search backends (`SEARCH_API`) |

## Progress events

`emit(kind, ...)` sends activity to the chat, shown in the research panel:
`plan`, `delegate`, `search`, `sources`, `findings`, `thinking`, `step`,
`status`, `error`, then `done` from `chat.py`. The report streams as normal
answer text and is saved in the thread with the activity.

## Models

The research model is the *Deep research* job model
(`llm.model_name("research_model")`); summaries use the small model. Long
inputs are trimmed to fit (`_fit_to_budget`, `_recent_rounds`).
