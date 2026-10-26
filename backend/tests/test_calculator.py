import importlib.util
import pathlib
import sys
import types
import unittest


def _load_calculator():
    try:
        import langchain_core  # noqa: F401
    except ImportError:
        lc = types.ModuleType("langchain_core")
        tools_mod = types.ModuleType("langchain_core.tools")
        tools_mod.tool = lambda f: f
        lc.tools = tools_mod
        sys.modules.setdefault("langchain_core", lc)
        sys.modules.setdefault("langchain_core.tools", tools_mod)
    path = pathlib.Path(__file__).resolve().parents[1] / "app" / "tools" / "calculator.py"
    spec = importlib.util.spec_from_file_location("calculator_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module.Calculator, "func", module.Calculator)


Calculator = _load_calculator()


class CalculatorTests(unittest.TestCase):
    def test_basic_arithmetic(self):
        self.assertEqual(Calculator("2", "3", "+"), 5)
        self.assertEqual(Calculator("10", "4", "-"), 6)
        self.assertEqual(Calculator("3", "4", "*"), 12)
        self.assertEqual(Calculator("10", "4", "/"), 2.5)

    def test_code_injection_is_rejected(self):
        payload = "__import__('os').popen('echo pwned').read()"
        with self.assertRaises((ValueError, TypeError)):
            Calculator(payload, "''", "+")

    def test_unknown_operator_is_rejected(self):
        with self.assertRaises((ValueError, TypeError)):
            Calculator("1", "2", "or")

    def test_division_by_zero(self):
        with self.assertRaises((ValueError, ZeroDivisionError)):
            Calculator("1", "0", "/")


if __name__ == "__main__":
    unittest.main()
