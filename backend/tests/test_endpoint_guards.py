"""Date query params must be validated at the middleware chokepoint.

These exercise the real ASGI app via TestClient — no network: rejected
requests never reach handler bodies, and the accepted-path probe only touches
Redis lookups that are None-safe offline.

The cron/materialize bearer-auth tests that used to live here went away with
the endpoints themselves: this build is local-only, has no Vercel crons, and
materializes ranges in-process (see data.queue_range_materialization).
"""
import importlib

import pytest
from fastapi.testclient import TestClient

import app as app_module


def _client(monkeypatch):
    """Build a TestClient against a freshly re-imported app.py."""
    importlib.reload(app_module)
    # Belt + suspenders: never let a test client kick off the real warmup
    monkeypatch.setattr(app_module, "start_warmup", lambda *a, **k: None)
    return TestClient(app_module.app)


@pytest.mark.parametrize("url", [
    "/api/games?date=banana",
    "/api/games?date=2026-13-99",
    "/api/pitch-data?date=20260401",
    "/api/pitcher-season-totals?pitcher_id=1&start_date=junk",
    "/api/last-refresh?date=not-a-date",
])
def test_malformed_date_params_get_400(monkeypatch, url):
    client = _client(monkeypatch)
    r = client.get(url)
    assert r.status_code == 400
    assert "expected YYYY-MM-DD" in r.text


def test_valid_and_absent_dates_pass_validation(monkeypatch):
    client = _client(monkeypatch)
    # last-refresh only does None-safe Redis lookups — safe offline
    assert client.get("/api/last-refresh?date=2026-04-01").status_code == 200
    assert client.get("/api/last-refresh").status_code == 200
