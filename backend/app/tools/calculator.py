import operator

from langchain_core.tools import tool

_OPS = {
    "+": operator.add,
    "-": operator.sub,
    "*": operator.mul,
    "/": operator.truediv,
    "%": operator.mod,
    "**": operator.pow,
}

# Models often name the operation instead of using the symbol.
_ALIASES = {
    "add": "+", "plus": "+", "sum": "+", "addition": "+",
    "subtract": "-", "minus": "-", "sub": "-", "subtraction": "-",
    "multiply": "*", "times": "*", "mul": "*", "x": "*", "×": "*", "multiplication": "*",
    "divide": "/", "div": "/", "÷": "/", "division": "/",
    "mod": "%", "modulo": "%", "remainder": "%",
    "pow": "**", "power": "**", "^": "**", "exponent": "**",
}


@tool
def Calculator(first_num: float, second_num: float, evaluator: str):
    """Do one arithmetic operation on two numbers.

    evaluator is the operator: "+", "-", "*", "/", "%" (remainder) or "**" (power).
    """
    symbol = str(evaluator).strip().lower()
    op = _OPS.get(_ALIASES.get(symbol, symbol))
    if op is None:
        raise ValueError(f"Unsupported operator: {evaluator!r}")
    try:
        first = float(first_num)
        second = float(second_num)
    except (TypeError, ValueError):
        raise ValueError("Calculator inputs must be numbers") from None
    if op in (operator.truediv, operator.mod) and second == 0:
        raise ValueError("Division by zero")
    return op(first, second)
