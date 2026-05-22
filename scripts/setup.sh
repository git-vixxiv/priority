#!/usr/bin/env bash
# One-time environment setup for the Priority engine.
# Run: bash scripts/setup.sh

set -e

echo "=== Priority Engine Setup ==="
echo ""

# 1. Python dependencies
echo "Installing Python dependencies..."
pip install -r requirements.txt

# 2. Check for uvx (needed for MCP server)
if ! command -v uvx &>/dev/null; then
  echo "Installing uv (for MCP server runtime)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# 3. Install the Google Sheets MCP server
echo "Installing mcp-gsheet MCP server..."
uvx mcp-gsheet --help &>/dev/null || uvx install mcp-gsheet

echo ""
echo "=== Required Environment Variables ==="
echo ""
echo "Add these to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
echo ""
echo "  export GOOGLE_SHEETS_CREDENTIALS_PATH=/path/to/credentials.json"
echo "  export PRIORITY_SPREADSHEET_ID=your_google_sheet_id"
echo "  export PRIORITY_SHEET_TAB=Priorities"
echo ""
echo "=== Google Cloud Setup ==="
echo ""
echo "1. Go to https://console.cloud.google.com/"
echo "2. Create a project (or select existing)"
echo "3. Enable 'Google Sheets API'"
echo "4. Go to APIs & Services → Credentials"
echo "5. Create OAuth 2.0 Client ID → Desktop Application"
echo "6. Download the JSON and set GOOGLE_SHEETS_CREDENTIALS_PATH"
echo "7. Create a new Google Sheet"
echo "8. Copy the Sheet ID from the URL and set PRIORITY_SPREADSHEET_ID"
echo ""
echo "Then run:"
echo "  python scripts/setup_sheet.py"
echo ""
echo "=== MCP Configuration ==="
echo ""
echo "The .claude/settings.json file is pre-configured."
echo "Open Claude Code in this directory and MCP will connect automatically."
echo ""
echo "Setup complete."
