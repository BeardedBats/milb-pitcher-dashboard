"""Vercel serverless entry point – exposes the FastAPI app for the Python runtime."""
import sys
import os

# Make the backend package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app import app  # noqa: E402, F401
