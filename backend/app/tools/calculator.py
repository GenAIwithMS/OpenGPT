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


@tool
def Calculator(first_num, second_num, evaluator):
    """Performe basic arthematic opration between two numbers"""
    op = _OPS.get(str(evaluator).strip())
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
