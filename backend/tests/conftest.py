import sys
from pathlib import Path

# Make backend/ importable the same way the serverless entry does
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
