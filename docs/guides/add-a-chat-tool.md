# Add a chat tool

A tool is a Python function the chat model can call. Example: a `Currency`
tool that converts amounts.

## 1. Write the tool

`backend/app/tools/currency.py`:

```python
import os

import httpx
from langchain_core.tools import tool


@tool
def Currency(amount: float, from_code: str, to_code: str) -> str:
    """Convert an amount between currencies, e.g. 100 USD to EUR.

    from_code and to_code are ISO 4217 codes such as "USD" or "PKR".
    """
    key = os.getenv("CURRENCY_API_KEY")
    if not key:
        return "Currency conversion isn't set up (CURRENCY_API_KEY is missing)."
    ...  # call the API with a timeout; return a short, plain answer
```

- The name and docstring are what the model sees: say what it does, when to
  use it, and what each argument means.
- Return short text. Raise `ValueError` for bad input: the tool node turns
  errors into a message the model can act on.
- Set a timeout on every network call and never put keys in the output.

## 2. Offer it to the model

- Export it in `app/tools/__init__.py`.
- Add it to `all_tools` in `app/services/chatbot.py` (offered every message),
  or append it in `chat_node` only when it is usable, as the `Knowledge`
  tool is.
- Optional: a friendlier status line in `ChatService._relay_chat_stream`
  (`app/services/chat.py`); the default is "Using Currency...".

## 3. Document its setting

Add `CURRENCY_API_KEY` to `backend/.env.example` (Tool API keys section) and
to [configuration.md](../configuration.md).

## 4. Test it

`backend/tests/test_currency.py`: call the function directly
(`Currency.func(...)`), fake the API with `unittest.mock` or a local
`http.server`, and cover the missing key, bad codes and a failing API.
