"""Společné nastavení testů: izolovaná data a sestavování ukázkových HTML stránek."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Testy nesmí sahat do uživatelských dat v projektu.
os.environ.setdefault("TIPSTER_DATA_DIR", tempfile.mkdtemp(prefix="tipster-tests-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
