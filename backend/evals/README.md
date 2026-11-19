# LangSmith evaluation for OpenGPT

This folder now has two complementary evaluation paths:

1. **Trace report**: a lightweight JSON summary of the runs already emitted into LangSmith.
2. **Dataset-backed LangSmith experiment**: snapshots recent traced runs into fresh LangSmith datasets and launches native LangSmith experiments so the results show up cleanly in the LangSmith UI.

## 1) Trace report

### What it checks

- `chat_node` / `My GPT` style traces:
  - answer is present
  - the trace is error-free
  - the response has some substance
- document RAG traces:
  - retrieved context is present
  - source file metadata is present
- document ingest traces:
  - the document was indexed into chunks successfully

### Run it

```bash
cd backend
python -m evals.online_eval --project OpenGPT --limit 50
```

The report is written to `backend/evals/results/`.

## 2) Dataset-backed LangSmith experiment

This flow uses traced runs as the source of truth, then creates fresh LangSmith datasets for:

- chat examples
- document retrieval examples

It then runs LangSmith evaluation experiments so you can review the results directly in the LangSmith UI.

### Run it

```bash
cd backend
python -m evals.langsmith_dataset_eval --project OpenGPT --limit 50
```

That command creates a timestamped dataset snapshot each time it runs and writes a manifest to `backend/evals/results/`.

## Notes

- Make sure `LANGSMITH_TRACING=true` and `LANGSMITH_PROJECT=OpenGPT` are set.
- The app now loads LangSmith config before importing the traced modules, so the traced nodes are picked up consistently when the backend starts.
- If you later add `@traceable(...)` to more service methods, they will show up in the trace report automatically as long as their names are listed in `backend/evals/online_eval.py`.
- The dataset-backed flow intentionally keeps the examples lightweight and uses fresh snapshot datasets so each evaluation run is isolated in LangSmith.
