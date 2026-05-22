"""Google Sheets initialization — creates and validates the priority spreadsheet schema."""

from __future__ import annotations
import os
import sys
from datetime import date
from typing import Any

from .schema import COLUMN_NAMES, COLUMNS, STATUS_VALUES, FIBONACCI_SCALE, validate_row


def get_sheets_service():
    """Build an authenticated Google Sheets API service object."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        print(
            "Missing Google API libraries. Run:\n"
            "  pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client",
            file=sys.stderr,
        )
        sys.exit(1)

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds_path = os.environ.get("GOOGLE_SHEETS_CREDENTIALS_PATH")
    token_path = os.path.join(os.path.dirname(creds_path or "."), "token.json")

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, scopes)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not creds_path or not os.path.exists(creds_path):
                print(
                    "GOOGLE_SHEETS_CREDENTIALS_PATH is not set or file not found.\n"
                    "Set it to your OAuth 2.0 Desktop credentials JSON path.",
                    file=sys.stderr,
                )
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, scopes)
            creds = flow.run_local_server(port=0)
        with open(token_path, "w") as f:
            f.write(creds.to_json())

    return build("sheets", "v4", credentials=creds)


def setup_sheet(
    spreadsheet_id: str | None = None,
    tab_name: str | None = None,
    service=None,
) -> None:
    """
    Initialize or validate the priority Google Sheet.

    - Creates the header row if the sheet is empty
    - Validates column structure if rows already exist
    - Applies data validation for Status and Fibonacci fields
    - Sets up conditional formatting for Status column
    """
    spreadsheet_id = spreadsheet_id or os.environ.get("PRIORITY_SPREADSHEET_ID")
    tab_name = tab_name or os.environ.get("PRIORITY_SHEET_TAB", "Priorities")

    if not spreadsheet_id:
        print(
            "PRIORITY_SPREADSHEET_ID is not set. Create a Google Sheet and set this "
            "to the ID in the URL (the long alphanumeric string).",
            file=sys.stderr,
        )
        sys.exit(1)

    if service is None:
        service = get_sheets_service()

    ss = service.spreadsheets()
    sheet_range = f"{tab_name}!A1:Z1"

    result = ss.values().get(spreadsheetId=spreadsheet_id, range=sheet_range).execute()
    existing = result.get("values", [])

    if not existing:
        _write_headers(ss, spreadsheet_id, tab_name)
        _apply_formatting(ss, spreadsheet_id, tab_name, service)
        print(f"Sheet '{tab_name}' initialized with {len(COLUMN_NAMES)} columns.")
    else:
        existing_headers = existing[0] if existing else []
        missing = [c for c in COLUMN_NAMES if c not in existing_headers]
        extra = [c for c in existing_headers if c not in COLUMN_NAMES]
        if missing:
            print(f"WARNING: Sheet is missing columns: {missing}")
        if extra:
            print(f"INFO: Sheet has extra columns not in schema: {extra}")
        if not missing and not extra:
            print(f"Sheet '{tab_name}' schema is valid. {len(COLUMN_NAMES)} columns verified.")


def _write_headers(ss, spreadsheet_id: str, tab_name: str) -> None:
    ss.values().update(
        spreadsheetId=spreadsheet_id,
        range=f"{tab_name}!A1",
        valueInputOption="RAW",
        body={"values": [COLUMN_NAMES]},
    ).execute()


def _apply_formatting(ss, spreadsheet_id: str, tab_name: str, service) -> None:
    """Apply data validation and conditional formatting via batchUpdate."""
    # Get the sheet ID for the target tab
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    sheet_id = None
    for s in meta.get("sheets", []):
        if s["properties"]["title"] == tab_name:
            sheet_id = s["properties"]["sheetId"]
            break

    if sheet_id is None:
        return

    requests = []

    # Status column dropdown validation
    from .schema import COLUMN_INDEX, get_column_letter
    status_col = COLUMN_INDEX.get("Status", 16)
    requests.append({
        "setDataValidation": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": 1,
                "startColumnIndex": status_col,
                "endColumnIndex": status_col + 1,
            },
            "rule": {
                "condition": {
                    "type": "ONE_OF_LIST",
                    "values": [{"userEnteredValue": s} for s in sorted(STATUS_VALUES)],
                },
                "showCustomUi": True,
                "strict": True,
            },
        }
    })

    # Conditional formatting: colour rows by Status
    status_colors = {
        "Completed": {"red": 0.85, "green": 0.93, "blue": 0.83},
        "In Progress": {"red": 0.99, "green": 0.96, "blue": 0.82},
        "Blocked": {"red": 0.96, "green": 0.80, "blue": 0.80},
        "Deferred": {"red": 0.90, "green": 0.90, "blue": 0.90},
    }
    status_col_letter = get_column_letter("Status")
    for status, color in status_colors.items():
        requests.append({
            "addConditionalFormatRule": {
                "rule": {
                    "ranges": [{"sheetId": sheet_id, "startRowIndex": 1}],
                    "booleanRule": {
                        "condition": {
                            "type": "TEXT_EQ",
                            "values": [{"userEnteredValue": status}],
                        },
                        "format": {"backgroundColor": color},
                    },
                },
                "index": 0,
            }
        })

    if requests:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests},
        ).execute()


def read_all_tasks(
    spreadsheet_id: str | None = None,
    tab_name: str | None = None,
    service=None,
) -> list[dict[str, Any]]:
    """Read all tasks from the sheet and return as list of dicts."""
    from .schema import row_to_dict

    spreadsheet_id = spreadsheet_id or os.environ.get("PRIORITY_SPREADSHEET_ID")
    tab_name = tab_name or os.environ.get("PRIORITY_SHEET_TAB", "Priorities")

    if service is None:
        service = get_sheets_service()

    result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=f"{tab_name}!A1:Z",
    ).execute()

    rows = result.get("values", [])
    if not rows:
        return []

    headers = rows[0]
    tasks = []
    for row in rows[1:]:
        padded = row + [""] * (len(COLUMN_NAMES) - len(row))
        task = {headers[i]: padded[i] for i in range(min(len(headers), len(padded)))}
        if task.get("Task_ID"):
            tasks.append(task)
    return tasks


def write_task(
    task: dict[str, Any],
    spreadsheet_id: str | None = None,
    tab_name: str | None = None,
    service=None,
) -> None:
    """Append a new task row to the sheet."""
    from .schema import dict_to_row

    spreadsheet_id = spreadsheet_id or os.environ.get("PRIORITY_SPREADSHEET_ID")
    tab_name = tab_name or os.environ.get("PRIORITY_SHEET_TAB", "Priorities")

    if service is None:
        service = get_sheets_service()

    task["Last_Updated"] = str(date.today())
    errors = validate_row(task)
    if errors:
        raise ValueError("Task validation failed:\n" + "\n".join(f"  - {e}" for e in errors))

    row = dict_to_row(task)
    service.spreadsheets().values().append(
        spreadsheetId=spreadsheet_id,
        range=f"{tab_name}!A1",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [row]},
    ).execute()


def update_task_field(
    task_id: str,
    field: str,
    value: Any,
    spreadsheet_id: str | None = None,
    tab_name: str | None = None,
    service=None,
) -> None:
    """Update a single field for a task identified by Task_ID."""
    from .schema import COLUMN_INDEX, get_column_letter

    spreadsheet_id = spreadsheet_id or os.environ.get("PRIORITY_SPREADSHEET_ID")
    tab_name = tab_name or os.environ.get("PRIORITY_SHEET_TAB", "Priorities")

    if service is None:
        service = get_sheets_service()

    col_letter = get_column_letter(field)
    tasks = read_all_tasks(spreadsheet_id, tab_name, service)
    row_num = None
    for i, t in enumerate(tasks):
        if t.get("Task_ID") == task_id:
            row_num = i + 2  # +1 for header, +1 for 1-based index
            break

    if row_num is None:
        raise KeyError(f"Task_ID '{task_id}' not found in sheet.")

    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"{tab_name}!{col_letter}{row_num}",
        valueInputOption="USER_ENTERED",
        body={"values": [[str(value)]]},
    ).execute()
