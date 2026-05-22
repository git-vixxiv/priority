"""
Storage backend selector.

Uses Google Sheets when PRIORITY_SPREADSHEET_ID is set; otherwise local JSON.
All callers import from here so the switch is transparent.
"""

import os

def _use_sheets() -> bool:
    return bool(os.environ.get("PRIORITY_SPREADSHEET_ID"))


def get_backend():
    if _use_sheets():
        from ..sheets import setup as _backend
    else:
        from . import json_store as _backend
    return _backend
