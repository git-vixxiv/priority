#!/usr/bin/env python3
"""
One-time setup script for the Priority Google Sheet.

Run this once after configuring your environment variables:
  export GOOGLE_SHEETS_CREDENTIALS_PATH=/path/to/credentials.json
  export PRIORITY_SPREADSHEET_ID=your_sheet_id
  python scripts/setup_sheet.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from src.sheets.setup import setup_sheet

if __name__ == "__main__":
    setup_sheet()
