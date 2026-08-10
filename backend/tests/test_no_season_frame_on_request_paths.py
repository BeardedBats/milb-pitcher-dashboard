"""No request path may build a season-wide DataFrame.

A season is ~612k pitch rows — on the order of 1.3 GB as one frame, with a
transient 2x during pd.concat, against a 3009 MB function limit. Three
functions still assemble one:

    _load_persisted_range   fetch_date_range   fetch_date_range_materialized

They are QUARANTINED: kept because they are individually tested and document
the whole-frame semantics the streaming code must match, but callable only by
each other. Everything that used to call them now folds a day at a time
(fold_range_materialized, fetch_pitcher_rows_materialized, range_is_materialized,
or a per-day accumulator).

This test is a grep with an AST behind it, and it exists because the failure it
guards against is invisible in review: adding `df = fetch_date_range(start,
end)` to an endpoint looks completely ordinary and reads like every other data
fetch in the codebase. It only fails in production, on a cold instance, as an
out-of-memory kill — and, because a frozen background thread can resume inside
a later invocation, sometimes on a totally unrelated endpoint.
"""
import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]

# May not be called from anywhere outside the quarantine.
SEASON_FRAME_BUILDERS = {
    "_load_persisted_range",
    "fetch_date_range",
    "fetch_date_range_materialized",
}

# The quarantine itself: these may call each other, and nothing else may call
# them. Keep this set closed — widening it is the regression.
QUARANTINE = set(SEASON_FRAME_BUILDERS)

MODULES = ["app.py", "data.py", "aggregation.py", "boxscore_levels.py"]


def _calls_with_enclosing_function(path):
    """(enclosing function name, called name, line) for every call in a module."""
    tree = ast.parse(path.read_text())
    found = []

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.stack = []

        def _visit_func(self, node):
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_FunctionDef = _visit_func
        visit_AsyncFunctionDef = _visit_func

        def visit_Call(self, node):
            func = node.func
            name = getattr(func, "id", None) or getattr(func, "attr", None)
            if name:
                enclosing = self.stack[-1] if self.stack else "<module>"
                found.append((enclosing, name, node.lineno))
            self.generic_visit(node)

    Visitor().visit(tree)
    return found


@pytest.mark.parametrize("module", MODULES)
def test_no_module_calls_a_season_frame_builder(module):
    path = BACKEND / module
    if not path.exists():
        pytest.skip(f"{module} not present")

    offenders = [
        f"{module}:{line} {enclosing}() calls {called}()"
        for enclosing, called, line in _calls_with_enclosing_function(path)
        if called in SEASON_FRAME_BUILDERS and enclosing not in QUARANTINE
    ]

    assert not offenders, (
        "These build the league's whole season as one DataFrame (~1.3 GB) and will "
        "OOM-kill the function on Vercel:\n  "
        + "\n  ".join(offenders)
        + "\n\nFold the range a day at a time instead: fold_range_materialized for a "
          "general sweep, fetch_pitcher_rows_materialized for one pitcher, or "
          "range_is_materialized when only the boolean is needed."
    )


def test_quarantined_builders_still_exist():
    """If one is deleted, drop it from the sets above rather than letting this
    test silently pass on a name that no longer exists."""
    source = (BACKEND / "data.py").read_text()
    for name in SEASON_FRAME_BUILDERS:
        assert f"def {name}(" in source, f"{name} no longer exists in data.py"


def test_streaming_replacements_are_available():
    """The alternatives the failure message points at must actually exist."""
    import data as D

    for name in ("fold_range_materialized", "fetch_pitcher_rows_materialized",
                 "range_is_materialized", "unbaked_range_days"):
        assert callable(getattr(D, name, None)), f"data.{name} is missing"
