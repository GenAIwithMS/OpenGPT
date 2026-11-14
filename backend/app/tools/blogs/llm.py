"""Model used by the blog writer (BLOG_MODEL, defaults to LLM_MODEL)."""
from app.llm import LazyChatModel

llm = LazyChatModel("blog_model")
