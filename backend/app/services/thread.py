import logging
from pydantic import BaseModel, Field
from langchain_openai import ChatOpenAI
from langchain_groq import ChatGroq
from dotenv import load_dotenv
import uuid
import os

logger = logging.getLogger(__name__)

load_dotenv()
# api = os.getenv("OPENAI_API_KEY")

# model = ChatOpenAI(
#     model="openai/gpt-oss-120b",
#     openai_api_key=api,
#     base_url="https://api.canopywave.io/v1"
#     )

api = os.getenv("GROQ_API_KEY")

model = ChatGroq(
    model="openai/gpt-oss-120b",
    api_key=api
    )

class StructuredModel(BaseModel):
    title: str = Field(description="A short chat title (<= 5 words).")


structured_model = model.with_structured_output(StructuredModel)


def generate_id_name(question: str):
    """Generate a short title from a question/message"""
    prompt = f"""
    Create a chat title in 5 words or fewer.
    Title only, no explanation.
    Question: {question}
    """

    try:
        llm = structured_model.invoke(prompt)
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


def generate_thread_title(message: str):
    """Generate a thread title from a message without circular dependencies"""
    name = generate_id_name(message)
    thread_id = generate_thread_id()
    return {thread_id: name}
