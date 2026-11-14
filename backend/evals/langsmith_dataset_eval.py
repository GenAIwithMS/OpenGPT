"""LangSmith dataset-backed evaluation flow for OpenGPT.

This companion to ``online_eval.py`` turns recent traced runs into fresh
LangSmith datasets and launches native LangSmith experiments so the results are
visible in the LangSmith UI.

It intentionally keeps the examples lightweight:
- chat traces become chat examples
- document retrieval traces become retrieval examples

Usage:

    cd backend
    python -m evals.langsmith_dataset_eval --project OpenGPT --limit 50

The command creates a fresh snapshot dataset for each run, then evaluates it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from langsmith import Client

try:  # LangSmith UI experiments require the evaluation helper.
    from langsmith.evaluation import evaluate
except Exception:  # pragma: no cover - keep the module importable if the helper moves
    evaluate = None

from app.observability import configure_langsmith

configure_langsmith()

from app.services.chat import ChatService
from app.services.rag import retrieve_from_document

REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = Path(os.getenv("OPENGPT_EVAL_RESULTS_DIR", REPO_ROOT / "evals" / "results")).resolve()
DEFAULT_PROJECT = os.getenv("LANGSMITH_PROJECT", "OpenGPT")
DEFAULT_LIMIT = int(os.getenv("OPENGPT_EVAL_LIMIT", "50"))
DATASET_PREFIX = os.getenv("OPENGPT_DATASET_PREFIX", "OpenGPT")
SNAPSHOT_SUFFIX = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

NODE_NAMES = {
    "chat_node",
    "My GPT",
    "rag.retrieve_from_document",
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    if hasattr(value, "dict") and callable(getattr(value, "dict")):
        try:
            maybe = value.dict()
            if isinstance(maybe, dict):
                return maybe
        except Exception:
            pass
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        try:
            maybe = value.model_dump()
            if isinstance(maybe, dict):
                return maybe
        except Exception:
            pass
    return {}


def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if hasattr(value, "content"):
        try:
            content = getattr(value, "content")
            if content is not None:
                return _flatten_text(content)
        except Exception:
            pass
    if isinstance(value, dict):
        bits = []
        for key in ("response", "answer", "content", "output", "text", "final", "final_report", "messages"):
            if key in value:
                bits.append(_flatten_text(value.get(key)))
        if bits:
            return "\n".join(bit for bit in bits if bit)
        return "\n".join(_flatten_text(v) for v in value.values() if v)
    if isinstance(value, (list, tuple, set)):
        return "\n".join(_flatten_text(v) for v in value if v)
    return str(value)


def _first_non_empty(*values: Any) -> str:
    for value in values:
        text = _flatten_text(value).strip()
        if text:
            return text
    return ""


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def _token_f1(predicted: str, expected: str) -> float:
    pred_tokens = _normalize_text(predicted).split()
    exp_tokens = _normalize_text(expected).split()
    if not pred_tokens or not exp_tokens:
        return 0.0

    pred_set = set(pred_tokens)
    exp_set = set(exp_tokens)
    overlap = len(pred_set & exp_set)
    if overlap == 0:
        return 0.0
    precision = overlap / len(pred_set)
    recall = overlap / len(exp_set)
    return (2 * precision * recall) / (precision + recall)


def _iter_runs(client: Client, project_name: str, limit: int) -> Iterable[Any]:
    try:
        runs = client.list_runs(project_name=project_name)
    except TypeError:
        runs = client.list_runs(project_name)
    for idx, run in enumerate(runs):
        if limit and idx >= limit:
            break
        yield run


def _kind_from_name(name: str) -> str:
    low = (name or "").lower()
    if "retrieve" in low:
        return "retrieval"
    if "chat" in low or low == "my gpt":
        return "chat"
    return "other"


def _thread_id_from_inputs(inputs: dict[str, Any]) -> str:
    return _first_non_empty(
        inputs.get("thread_id"),
        inputs.get("metadata", {}).get("thread_id") if isinstance(inputs.get("metadata"), dict) else "",
        inputs.get("configurable", {}).get("thread_id") if isinstance(inputs.get("configurable"), dict) else "",
    )


def _human_message_from_inputs(inputs: dict[str, Any]) -> str:
    messages = inputs.get("messages") or []
    for item in reversed(messages):
        if isinstance(item, dict):
            role = (item.get("type") or item.get("role") or item.get("_type") or "").lower()
            if role in {"human", "user"}:
                text = _first_non_empty(item.get("content"), item.get("text"))
                if text:
                    return text
        else:
            role = (getattr(item, "type", "") or getattr(item, "role", "") or "").lower()
            if role in {"human", "user"} or item.__class__.__name__.lower().startswith("human"):
                text = _first_non_empty(getattr(item, "content", ""), getattr(item, "text", ""))
                if text:
                    return text
    return _first_non_empty(inputs.get("message"), inputs.get("query"), inputs.get("prompt"))


def _chat_response_from_outputs(outputs: dict[str, Any]) -> str:
    response = _first_non_empty(
        outputs.get("response"),
        outputs.get("answer"),
        outputs.get("content"),
        outputs.get("output"),
    )
    if response:
        return response
    messages = outputs.get("messages") or []
    for item in reversed(messages):
        if isinstance(item, dict):
            role = (item.get("type") or item.get("role") or item.get("_type") or "").lower()
            if role in {"ai", "assistant"}:
                text = _first_non_empty(item.get("content"), item.get("text"))
                if text:
                    return text
        else:
            role = (getattr(item, "type", "") or getattr(item, "role", "") or "").lower()
            if role in {"ai", "assistant"} or item.__class__.__name__.lower().startswith("ai"):
                text = _first_non_empty(getattr(item, "content", ""), getattr(item, "text", ""))
                if text:
                    return text
    return ""


def _context_from_outputs(outputs: dict[str, Any]) -> list[str]:
    context = outputs.get("context")
    if isinstance(context, list):
        return [str(item) for item in context if _flatten_text(item).strip()]
    if context:
        text = _flatten_text(context).strip()
        return [text] if text else []
    return []


def _source_from_outputs(outputs: dict[str, Any]) -> str:
    return _first_non_empty(outputs.get("source_file"), outputs.get("filename"), outputs.get("source"))


# ---------------------------------------------------------------------------
# Trace -> dataset snapshot conversion
# ---------------------------------------------------------------------------

def _chat_example_from_run(run: Any) -> dict[str, Any] | None:
    inputs = _as_dict(getattr(run, "inputs", None))
    outputs = _as_dict(getattr(run, "outputs", None))
    response = _chat_response_from_outputs(outputs)
    message = _human_message_from_inputs(inputs)
    thread_id = _thread_id_from_inputs(inputs)

    if not message or not response:
        return None

    return {
        "inputs": {
            "kind": "chat",
            "message": message,
            "thread_id": thread_id,
            "tools": inputs.get("tools"),
        },
        "outputs": {
            "expected_response": response,
            "trace_name": getattr(run, "name", None),
            "trace_id": str(getattr(run, "id", "")),
        },
    }


def _retrieval_example_from_run(run: Any) -> dict[str, Any] | None:
    inputs = _as_dict(getattr(run, "inputs", None))
    outputs = _as_dict(getattr(run, "outputs", None))
    query = _first_non_empty(inputs.get("query"), inputs.get("message"), inputs.get("prompt"))
    thread_id = _thread_id_from_inputs(inputs)
    context = _context_from_outputs(outputs)
    source_file = _source_from_outputs(outputs)

    if not query or not context:
        return None

    return {
        "inputs": {
            "kind": "retrieval",
            "query": query,
            "thread_id": thread_id,
        },
        "outputs": {
            "expected_context": context,
            "source_file": source_file,
            "trace_name": getattr(run, "name", None),
            "trace_id": str(getattr(run, "id", "")),
        },
    }


def build_snapshot_examples(project_name: str, limit: int) -> dict[str, list[dict[str, Any]]]:
    client = Client()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for run in _iter_runs(client, project_name, limit):
        name = getattr(run, "name", "") or ""
        if name not in NODE_NAMES:
            continue

        kind = _kind_from_name(name)
        if kind == "chat":
            example = _chat_example_from_run(run)
        elif kind == "retrieval":
            example = _retrieval_example_from_run(run)
        else:
            example = None

        if example is not None:
            grouped[kind].append(example)

    return grouped


# ---------------------------------------------------------------------------
# Dataset creation + native LangSmith evaluation
# ---------------------------------------------------------------------------

def _create_dataset_snapshot(client: Client, dataset_name: str, description: str, examples: list[dict[str, Any]]) -> int:
    try:
        dataset = client.create_dataset(dataset_name=dataset_name, description=description)
    except TypeError:
        dataset = client.create_dataset(name=dataset_name, description=description)
    for example in examples:
        client.create_example(
            inputs=example["inputs"],
            outputs=example["outputs"],
            dataset_id=dataset.id,
        )
    return len(examples)


def _run_native_evaluation(
    *,
    target: Any,
    dataset_name: str,
    evaluators: list[Any],
    experiment_prefix: str,
) -> Any:
    try:
        return evaluate(
            target=target,
            data=dataset_name,
            evaluators=evaluators,
            experiment_prefix=experiment_prefix,
        )
    except TypeError:
        return evaluate(target, dataset_name, evaluators=evaluators, experiment_prefix=experiment_prefix)


# ---------------------------------------------------------------------------
# Predictors + evaluators for LangSmith UI experiments
# ---------------------------------------------------------------------------

def _predict_chat(inputs: dict[str, Any]) -> dict[str, Any]:
    # Always a fresh thread, deleted afterwards. The dataset's thread_id comes
    # from real traced chats; replaying into it would add eval turns to a
    # user's conversation.
    thread_id = ChatService.create_new_thread()
    try:
        result = ChatService.send_message(inputs["message"], thread_id, tools=inputs.get("tools"))
    finally:
        ChatService.delete_thread(thread_id)
    return {
        "response": result.get("response", ""),
        "thread_id": thread_id,
        "has_tool_calls": result.get("has_tool_calls", False),
        "tool_used": result.get("tool_used"),
    }


def _predict_retrieval(inputs: dict[str, Any]) -> dict[str, Any]:
    thread_id = _first_non_empty(inputs.get("thread_id"))
    if not thread_id:
        return {"error": "Missing thread_id", "query": inputs.get("query", "")}
    return retrieve_from_document(inputs["query"], thread_id)


def _chat_response_present(run: Any, example: Any) -> dict[str, Any]:
    predicted = _chat_response_from_outputs(_as_dict(getattr(run, "outputs", None)))
    score = 1.0 if predicted.strip() else 0.0
    return {
        "key": "chat.response_present",
        "score": score,
        "comment": "response is non-empty" if score else "response is empty",
    }


def _chat_response_similarity(run: Any, example: Any) -> dict[str, Any]:
    predicted = _chat_response_from_outputs(_as_dict(getattr(run, "outputs", None)))
    expected = _first_non_empty(_as_dict(getattr(example, "outputs", None)).get("expected_response"))
    score = _token_f1(predicted, expected)
    return {
        "key": "chat.response_similarity",
        "score": score,
        "comment": f"token F1={score:.2f}",
    }


def _retrieval_context_present(run: Any, example: Any) -> dict[str, Any]:
    outputs = _as_dict(getattr(run, "outputs", None))
    context = _context_from_outputs(outputs)
    score = 1.0 if context else 0.0
    return {
        "key": "retrieval.context_present",
        "score": score,
        "comment": f"{len(context)} chunks" if context else "no retrieved context",
    }


def _retrieval_source_match(run: Any, example: Any) -> dict[str, Any]:
    outputs = _as_dict(getattr(run, "outputs", None))
    expected = _normalize_text(_first_non_empty(_as_dict(getattr(example, "outputs", None)).get("source_file")))
    predicted = _normalize_text(_source_from_outputs(outputs))
    score = 1.0 if expected and predicted and expected == predicted else 0.0
    return {
        "key": "retrieval.source_match",
        "score": score,
        "comment": f"predicted={predicted or 'missing'} expected={expected or 'missing'}",
    }


def _retrieval_context_similarity(run: Any, example: Any) -> dict[str, Any]:
    outputs = _as_dict(getattr(run, "outputs", None))
    predicted = "\n".join(_context_from_outputs(outputs))
    expected_context = _as_dict(getattr(example, "outputs", None)).get("expected_context") or []
    expected = "\n".join(expected_context) if isinstance(expected_context, list) else _flatten_text(expected_context)
    score = _token_f1(predicted, expected)
    return {
        "key": "retrieval.context_similarity",
        "score": score,
        "comment": f"token F1={score:.2f}",
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_langsmith_dataset_eval(project_name: str = DEFAULT_PROJECT, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    if evaluate is None:
        raise RuntimeError(
            "langsmith.evaluation.evaluate is not available in this environment. "
            "Upgrade the LangSmith package or run the trace-only report in evals.online_eval instead."
        )

    snapshot = build_snapshot_examples(project_name, limit)
    timestamp = SNAPSHOT_SUFFIX
    client = Client()

    dataset_prefix = f"{DATASET_PREFIX} {timestamp}"
    manifest = {
        "metadata": {
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "project_name": project_name,
            "limit": limit,
        },
        "datasets": {},
    }

    if snapshot.get("chat"):
        dataset_name = f"{dataset_prefix} chat"
        count = _create_dataset_snapshot(
            client,
            dataset_name=dataset_name,
            description=f"Snapshot of recent chat traces from LangSmith project {project_name}.",
            examples=snapshot["chat"],
        )
        manifest["datasets"]["chat"] = {"name": dataset_name, "examples": count}

        _run_native_evaluation(
            target=_predict_chat,
            dataset_name=dataset_name,
            evaluators=[_chat_response_present, _chat_response_similarity],
            experiment_prefix=f"{dataset_name} experiment",
        )

    if snapshot.get("retrieval"):
        dataset_name = f"{dataset_prefix} retrieval"
        count = _create_dataset_snapshot(
            client,
            dataset_name=dataset_name,
            description=f"Snapshot of recent document retrieval traces from LangSmith project {project_name}.",
            examples=snapshot["retrieval"],
        )
        manifest["datasets"]["retrieval"] = {"name": dataset_name, "examples": count}

        _run_native_evaluation(
            target=_predict_retrieval,
            dataset_name=dataset_name,
            evaluators=[_retrieval_context_present, _retrieval_source_match, _retrieval_context_similarity],
            experiment_prefix=f"{dataset_name} experiment",
        )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = RESULTS_DIR / f"langsmith-dataset-manifest-{timestamp}.json"
    report_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n=== LangSmith dataset evaluation ===")
    print(f"project: {project_name}")
    for kind, info in manifest["datasets"].items():
        print(f"  {kind:<10} dataset={info['name']}  examples={info['examples']}")
    print(f"manifest written to: {report_path}")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args()
    run_langsmith_dataset_eval(project_name=args.project, limit=args.limit)


if __name__ == "__main__":
    main()
