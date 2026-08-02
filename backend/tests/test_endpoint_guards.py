"""Cron/materialize endpoints must fail CLOSED; date params must be validated.

These exercise the real ASGI app via TestClient — no network: rejected
requests never reach handler bodies, and the accepted-path probe only touches
Redis lookups that are None-safe offline.
"""
import importlib
import os

import pytest
from fastapi.testclient import TestClient

import app as app_module

CRON_PATHS = [
    "/api/cron/materialize-ranges",
    "/api/cron/warmup",
    "/api/cron/stat-corrections",
    "/api/cron/warmup-daily",
    "/api/cron/warmup-daily-2",
    "/api/cron/warmup-daily-players",
    "/api/cron/warmup-daily-cards",
    "/api/cron/warmup-live-cards",
    "/api/cron/warmup-live-game-views",
    "/api/materialize-range?start_date=2026-04-01&end_date=2026-04-02",
    "/api/materialize-status?start_date=2026-04-01&end_date=2026-04-02",
]


def _client(monkeypatch, *, vercel, secret):
    """Build a TestClient against app.py re-imported under the given env."""
    if vercel:
        monkeypatch.setenv("VERCEL", "1")
    else:
        monkeypatch.delenv("VERCEL", raising=False)
    if secret is None:
        monkeypatch.delenv("CRON_SECRET", raising=False)
    else:
        monkeypatch.setenv("CRON_SECRET", secret)
    importlib.reload(app_module)
    # Belt + suspenders: never let a test client kick off the real warmup
    monkeypatch.setattr(app_module, "start_warmup", lambda *a, **k: None)
    return TestClient(app_module.app)


@pytest.fixture(autouse=True, scope="module")
def _restore_app_module():
    yield
    os.environ.pop("VERCEL", None)
    os.environ.pop("CRON_SECRET", None)
    importlib.reload(app_module)


@pytest.mark.parametrize("path", CRON_PATHS)
def test_cron_requires_bearer_in_serverless(monkeypatch, path):
    client = _client(monkeypatch, vercel=True, secret="test-secret")
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 401


@pytest.mark.parametrize("path", CRON_PATHS)
def test_cron_fails_closed_when_secret_unset(monkeypatch, path):
    # The audit fix: the old fail-open guards executed the handler for ANYONE
    # whenever CRON_SECRET was unset.
    client = _client(monkeypatch, vercel=True, secret=None)
    assert client.get(path).status_code == 401


def test_correct_bearer_is_accepted(monkeypatch):
    client = _client(monkeypatch, vercel=True, secret="test-secret")
    r = client.get(
        "/api/materialize-status?start_date=2026-04-01&end_date=2026-04-02",
        headers={"Authorization": "Bearer test-secret"},
    )
    assert r.status_code != 401


def test_materialize_endpoints_require_secret_even_locally(monkeypatch):
    # /api/materialize-* are admin endpoints, not crons: unlike the cron
    # handlers they stay locked even off-serverless, because they can trigger a
    # full-season Savant pull.
    client = _client(monkeypatch, vercel=False, secret=None)
    assert client.get(
        "/api/materialize-range?start_date=2026-04-01&end_date=2026-04-02"
    ).status_code == 401


@pytest.mark.parametrize("url", [
    "/api/games?date=banana",
    "/api/games?date=2026-13-99",
    "/api/pitch-data?date=20260401",
    "/api/pitcher-season-totals?pitcher_id=1&start_date=junk",
    "/api/last-refresh?date=not-a-date",
])
def test_malformed_date_params_get_400(monkeypatch, url):
    client = _client(monkeypatch, vercel=False, secret=None)
    r = client.get(url)
    assert r.status_code == 400
    assert "expected YYYY-MM-DD" in r.text


def test_valid_and_absent_dates_pass_validation(monkeypatch):
    client = _client(monkeypatch, vercel=False, secret=None)
    # last-refresh only does None-safe Redis lookups — safe offline
    assert client.get("/api/last-refresh?date=2026-04-01").status_code == 200
    assert client.get("/api/last-refresh").status_code == 200
