import logging
import uuid

from pydantic import BaseModel, Field

from app.llm import LazyChatModel

logger = logging.getLogger(__name__)

# Titles are short: use the small model (LLM_SMALL_MODEL, defaults to LLM_MODEL).
model = LazyChatModel("small_model")


class StructuredModel(BaseModel):
    title: str = Field(description="A short chat title (<= 5 words).")


def generate_id_name(question: str):
    """Generate a short title from a question/message"""
    prompt = f"""
    Create a chat title in 5 words or fewer.
    Title only, no explanation.
    Question: {question}
    """

    try:
        llm = model.with_structured_output(StructuredModel).invoke(prompt)
        if llm and hasattr(llm, "title") and llm.title:
            return llm.title
    except Exception as e:
        logger.warning("STRUCTURED PARSE ERROR: %s", e)

    # fallback to raw text
    raw = model.invoke(prompt)
    return raw.content.strip()


def generate_thread_id():
    """Generate a unique thread ID"""
    thread_id = str(uuid.uuid4())
    return thread_id
