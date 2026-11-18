# Blogs

Writes a full blog post from a topic when the user picks **Blogs** in the
tools menu.

## How it works

The graph is in `app/tools/blogs/graph.py`:

1. **Router**: decides whether the topic needs research.
2. **Research** (when needed): gathers dated sources with Tavily
   (`TAVILY_API_KEY`); without the key the post is written from the
   model's knowledge.
3. **Orchestrator**: plans the post and its sections (at most
   `MAX_BLOG_SECTIONS`).
4. **Workers**: write the sections in parallel.
5. **Reducer**: merges the sections and, when `GOOGLE_API_KEY` is set,
   generates images. Images are saved in `backend/app/storage/blog_images/`
   and served at `/api/blog-images/{file}`; without the key the post keeps
   captions only.

`ChatService._stream_blog` sends `progress` events for each step, then the
post, and saves the turn in the thread. The writer uses the blog model
(`BLOG_MODEL` or the per-job model in Settings > Developer).

## Files

`router.py`, `research.py`, `orchestrator.py`, `worker.py`, `reducer.py`,
`schemas.py`, `llm.py` in `app/tools/blogs/`.
