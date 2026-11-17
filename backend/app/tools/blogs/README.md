# Blog writer

A LangGraph workflow that writes a blog post from a topic. It runs when the
user picks Blogs in the chat's tools menu (`ChatService._stream_blog` in
`app/services/chat.py`). Overview: [docs/services/blogs.md](../../../../docs/services/blogs.md).

## Graph

```
START ─► router ─┬─► research ─► orchestrator ─┬─► worker ─┐
                 └──────────────► orchestrator │  (one per │
                                               │  section, ├─► reducer ─► END
                                               └─► worker ─┘   merge_content ─► decide_images ─► generate_and_place_images
```

- **router** (`router.py`): decides whether the topic needs fresh research:
  `closed_book` (evergreen), `hybrid` (needs recent examples) or
  `open_book` (news, "latest", prices; last 7 days), and writes search
  queries.
- **research** (`research.py`): runs the queries with Tavily and keeps
  dated evidence. **Needs `TAVILY_API_KEY`**; without it there is no
  evidence and the post is written from the model's knowledge.
- **orchestrator** (`orchestrator.py`): plans the title and sections
  (at most `MAX_BLOG_SECTIONS`) and fans out one worker per section.
- **worker** (`worker.py`): writes one section from its brief and the
  evidence.
- **reducer** (`reducer.py`): merges sections in order, decides where images
  help, and generates them with Gemini when `GOOGLE_API_KEY` is set
  (otherwise keeps captions). Images are saved in
  `backend/app/storage/blog_images/` and served at `/api/blog-images/{file}`.

## Files

`graph.py` (state and wiring), `schemas.py` (structured outputs: `Plan`,
`Task`, `RouterDecision`, `EvidencePack`, `ImageSpec`, ...), `llm.py` (the
*Blog writer* job model).

## Events

`chat.py` sends a `progress` event as each step finishes ("✓ Routing
complete - Mode: hybrid", "✓ Research complete - Found 6 sources",
"✓ Planning complete - 5 sections planned", "✓ Section written"), then the
post as answer text, and saves the turn in the thread.
