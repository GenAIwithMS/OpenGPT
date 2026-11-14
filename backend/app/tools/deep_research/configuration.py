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
    PARALLEL = "parallel"
    NONE = "none"

class Configuration(BaseModel):
    max_structured_output_retries: int = Field(default=3)
    allow_clarification: bool = Field(default=True)
    max_concurrent_research_units: int = Field(default=5)
    search_api: SearchAPI = Field(default=SearchAPI.PARALLEL)
    max_researcher_iterations: int = Field(default=6)
    max_react_tool_calls: int = Field(default=10)
    summarization_model: Optional[str] = Field(default=None)
    summarization_model_max_tokens: int = Field(default=8192)
    max_content_length: int = Field(default=50000)
    # Largest block of gathered material sent in a single model request. Keeps
    # requests under low tokens-per-minute quotas; raise it on higher API tiers.
    max_context_chars: int = Field(default=16000)
    research_model: Optional[str] = Field(default=None)
    research_model_max_tokens: int = Field(default=10000)
    compression_model: Optional[str] = Field(default=None)
    compression_model_max_tokens: int = Field(default=8192)
    final_report_model: Optional[str] = Field(default=None)
    final_report_model_max_tokens: int = Field(default=10000)

    # Model fields left unset use RESEARCH_MODEL / LLM_MODEL (see app/llm.py),
    # with the provider configured there.

    @classmethod
    def from_runnable_config(
        cls, config: Optional[RunnableConfig] = None
    ) -> "Configuration":
        """Values from the run config, then environment variables, then defaults.

        A value passed explicitly for a run takes precedence over the
        environment-wide setting.
        """
        configurable = config.get("configurable", {}) if config else {}
        values: dict[str, Any] = {}
        for field_name in cls.model_fields:
            value = configurable.get(field_name)
            if value is None:
                value = os.environ.get(field_name.upper())
            if value is not None:
                values[field_name] = value
        return cls(**values)

    class Config:
        arbitrary_types_allowed = True
