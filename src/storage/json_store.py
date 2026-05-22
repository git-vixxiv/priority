"""Local JSON storage backend — drop-in replacement for Google Sheets."""

from __future__ import annotations
import json
import os
from datetime import date
from pathlib import Path
from typing import Any

from ..sheets.schema import validate_row, COLUMN_NAMES

_DEFAULT_PATH = Path(__file__).parent.parent.parent / "data" / "priorities.json"


def _db_path() -> Path:
    env = os.environ.get("PRIORITY_JSON_PATH")
    return Path(env) if env else _DEFAULT_PATH


def _load() -> list[dict[str, Any]]:
    p = _db_path()
    if not p.exists():
        return []
    with open(p) as f:
        return json.load(f)


def _save(tasks: list[dict[str, Any]]) -> None:
    p = _db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w") as f:
        json.dump(tasks, f, indent=2, default=str)


def _next_task_id(tasks: list[dict]) -> str:
    existing = [t.get("Task_ID", "") for t in tasks]
    nums = []
    for tid in existing:
        if tid.startswith("T-") and tid[2:].isdigit():
            nums.append(int(tid[2:]))
    next_n = max(nums, default=0) + 1
    return f"T-{next_n:03d}"


def read_all_tasks(
    spreadsheet_id=None, tab_name=None, service=None
) -> list[dict[str, Any]]:
    return _load()


def write_task(
    task: dict[str, Any],
    spreadsheet_id=None, tab_name=None, service=None
) -> str:
    tasks = _load()

    if not task.get("Task_ID"):
        task["Task_ID"] = _next_task_id(tasks)

    task.setdefault("Status", "Backlog")
    task["Last_Updated"] = str(date.today())

    errors = validate_row(task)
    if errors:
        raise ValueError("Task validation failed:\n" + "\n".join(f"  - {e}" for e in errors))

    # Replace if ID already exists, otherwise append
    for i, t in enumerate(tasks):
        if t.get("Task_ID") == task["Task_ID"]:
            tasks[i] = task
            _save(tasks)
            return task["Task_ID"]

    tasks.append(task)
    _save(tasks)
    return task["Task_ID"]


def update_task_field(
    task_id: str, field: str, value: Any,
    spreadsheet_id=None, tab_name=None, service=None
) -> None:
    tasks = _load()
    for task in tasks:
        if task.get("Task_ID") == task_id:
            task[field] = value
            task["Last_Updated"] = str(date.today())
            _save(tasks)
            return
    raise KeyError(f"Task_ID '{task_id}' not found.")


def delete_task(task_id: str) -> None:
    tasks = _load()
    new = [t for t in tasks if t.get("Task_ID") != task_id]
    if len(new) == len(tasks):
        raise KeyError(f"Task_ID '{task_id}' not found.")
    _save(new)


def setup_sheet(spreadsheet_id=None, tab_name=None, service=None) -> None:
    p = _db_path()
    if not p.exists():
        _save([])
        print(f"Initialized local JSON store at {p}")
    else:
        tasks = _load()
        print(f"JSON store at {p} — {len(tasks)} tasks.")
