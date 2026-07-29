"""Configuration management for the Open Deep Research system."""

import os
from enum import Enum
from typing import Any, Optional

from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field


class SearchAPI(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    TAVILY = "tavily"
    DUCKDUCKGO = "duckduckgo"
    NONE = "none"

class Configuration(BaseModel):
    max_structured_output_retries: int = Field(default=3)
    allow_clarification: bool = Field(default=True)
    max_concurrent_research_units: int = Field(default=5)
    search_api: SearchAPI = Field(default=SearchAPI.DUCKDUCKGO)
    max_researcher_iterations: int = Field(default=6)
    max_react_tool_calls: int = Field(default=10)
    summarization_model: str = Field(default="groq:openai/gpt-oss-120b")
    summarization_model_max_tokens: int = Field(default=8192)
    max_content_length: int = Field(default=50000)
    research_model: str = Field(default="groq:openai/gpt-oss-120b")
    research_model_max_tokens: int = Field(default=10000)
    compression_model: str = Field(default="groq:openai/gpt-oss-120b")
    compression_model_max_tokens: int = Field(default=8192)
    final_report_model: str = Field(default="groq:openai/gpt-oss-120b")
    final_report_model_max_tokens: int = Field(default=10000)

    @classmethod
    def from_runnable_config(
        cls, config: Optional[RunnableConfig] = None
    ) -> "Configuration":
        configurable = config.get("configurable", {}) if config else {}
        field_names = list(cls.model_fields.keys())
        values: dict[str, Any] = {
            field_name: os.environ.get(field_name.upper(), configurable.get(field_name))
            for field_name in field_names
        }
        return cls(**{k: v for k, v in values.items() if v is not None})

    class Config:
        arbitrary_types_allowed = True
