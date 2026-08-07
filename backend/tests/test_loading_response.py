"""The 202 "cache is rebuilding" body must carry a pacing hint.

A 202 used to say only "not ready", and the client retried on a flat timer
forever — 473 requests in 45 minutes, measured, against an endpoint that could
not succeed. The client now backs off on its own, but the server is what knows
its real cadence (materialization only advances when the 5-minute cron runs),
so it publishes that as retry_after. See frontend/src/utils/pollBackoff.js.
"""
import json

from fastapi import Response

import app as app_module


def _loading_body(monkeypatch, job):
    monkeypatch.setattr(app_module, "queue_range_materialization", lambda s, e: job)
    resp = app_module._loading_response(Response(), "2026-03-25", "2026-08-06")
    return resp, json.loads(bytes(resp.body).decode("utf-8"))


def test_loading_response_publishes_retry_after(monkeypatch):
    resp, body = _loading_body(monkeypatch, {"status": "pending", "queued": True})

    assert resp.status_code == 202
    assert body["retry_after"] == app_module.LOADING_RETRY_AFTER_SECONDS
    # Also as the standard header, so anything that isn't our client (a proxy,
    # curl, a future caller) gets the same guidance.
    assert resp.headers["Retry-After"] == str(app_module.LOADING_RETRY_AFTER_SECONDS)
    assert body["status"] == "pending"
    assert body["materialization_started"] is True


def test_retry_after_is_long_enough_to_be_worth_honouring(monkeypatch):
    # A hint shorter than the client's own opening backoff (2s) would be
    # pointless — the client floors at max(hint, backoff) — and one longer than
    # the client's hard cap (5 min) would simply be clamped away.
    assert 2 <= app_module.LOADING_RETRY_AFTER_SECONDS <= 300


def test_loading_response_still_surfaces_job_errors(monkeypatch):
    _, body = _loading_body(
        monkeypatch,
        {"status": "error", "queued": False, "error": "Redis is not configured."},
    )

    assert body["status"] == "error"
    assert body["error"] == "Redis is not configured."
    # The hint rides along regardless; the client treats an "error" body as
    # terminal and stops anyway.
    assert body["retry_after"] == app_module.LOADING_RETRY_AFTER_SECONDS
