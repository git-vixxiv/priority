"""FastAPI backend for the Priority Engine browser UI."""

from __future__ import annotations
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
from datetime import date

from ..storage.backend import get_backend
from ..algorithms.wsjf import calculate_base_wsjf
from ..algorithms.scoring import run_full_analysis
from ..sheets.schema import FIBONACCI_SCALE

STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Priority Engine", docs_url="/api/docs")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ── Pydantic models ───────────────────────────────────────────────────────────

class TaskIn(BaseModel):
    Task_Name: str
    Category: str = ""
    Value_Score: int = 3
    Time_Criticality: int = 3
    RR_OE_Score: int = 3
    Job_Size: int = 3
    Duration_Days: Optional[int] = None
    Predecessor_IDs: str = ""
    Notes: str = ""
    Status: str = "Backlog"
    Stakes_Description: str = ""
    External_Blockers: str = ""
    Dependency_Hints: str = ""


class TaskPatch(BaseModel):
    Task_Name: Optional[str] = None
    Category: Optional[str] = None
    Value_Score: Optional[int] = None
    Time_Criticality: Optional[int] = None
    RR_OE_Score: Optional[int] = None
    Job_Size: Optional[int] = None
    Duration_Days: Optional[int] = None
    Predecessor_IDs: Optional[str] = None
    Notes: Optional[str] = None
    Status: Optional[str] = None
    Stakes_Description: Optional[str] = None
    External_Blockers: Optional[str] = None
    Dependency_Hints: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _b():
    return get_backend()


def _check_fibs(**kwargs):
    for field, val in kwargs.items():
        if val is not None and val not in FIBONACCI_SCALE:
            raise HTTPException(400, f"{field}={val} is not a valid Fibonacci value (1,2,3,5,8,13,20,40,100)")


# ── Task CRUD ─────────────────────────────────────────────────────────────────

@app.get("/api/tasks")
def list_tasks():
    tasks = _b().read_all_tasks()
    active = sorted(
        [t for t in tasks if t.get("Status") not in ("Completed", "Deferred")],
        key=lambda t: float(t.get("Adjusted_WSJF") or t.get("Base_WSJF") or 0),
        reverse=True,
    )
    done = [t for t in tasks if t.get("Status") in ("Completed", "Deferred")]
    return active + done


@app.post("/api/tasks", status_code=201)
def create_task(t: TaskIn):
    _check_fibs(Value_Score=t.Value_Score, Time_Criticality=t.Time_Criticality,
                RR_OE_Score=t.RR_OE_Score, Job_Size=t.Job_Size)
    base = calculate_base_wsjf(t.Value_Score, t.Time_Criticality, t.RR_OE_Score, t.Job_Size)
    data = t.model_dump()
    data.update(Base_WSJF=base, Adjusted_WSJF=base, Last_Updated=str(date.today()))
    if data["Duration_Days"] is None:
        data["Duration_Days"] = ""
    b = _b()
    tid = b.write_task(data)
    return next((x for x in b.read_all_tasks() if x.get("Task_ID") == tid), data)


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: str, patch: TaskPatch):
    b = _b()
    tasks = b.read_all_tasks()
    task = next((t for t in tasks if t.get("Task_ID") == task_id), None)
    if not task:
        raise HTTPException(404, f"Task {task_id} not found")

    changes = {k: v for k, v in patch.model_dump().items() if v is not None}
    score_fields = {"Value_Score", "Time_Criticality", "RR_OE_Score", "Job_Size"}
    _check_fibs(**{k: v for k, v in changes.items() if k in score_fields})

    if score_fields & changes.keys():
        m = {**task, **changes}
        try:
            bw = calculate_base_wsjf(
                int(m.get("Value_Score", 3)), int(m.get("Time_Criticality", 3)),
                int(m.get("RR_OE_Score", 3)), int(m.get("Job_Size", 3)),
            )
            changes["Base_WSJF"] = bw
            changes["Adjusted_WSJF"] = bw
        except Exception:
            pass

    for field, val in changes.items():
        b.update_task_field(task_id, field, val)

    return next((t for t in b.read_all_tasks() if t.get("Task_ID") == task_id), {})


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    try:
        from ..storage.json_store import delete_task as _del
        _del(task_id)
        return {"deleted": task_id}
    except KeyError:
        raise HTTPException(404, f"Task {task_id} not found")


# ── Analysis ──────────────────────────────────────────────────────────────────

@app.post("/api/analyze")
def analyze():
    tasks = _b().read_all_tasks()
    if not tasks:
        return {"tasks": [], "critical_path": [], "critical_path_duration": 0}
    try:
        ranked, cp_ids, cp_duration = run_full_analysis(tasks)
    except ValueError as e:
        raise HTTPException(422, str(e))

    b = _b()
    for task in ranked:
        tid = task.get("Task_ID")
        if not tid:
            continue
        for field in ("Adjusted_WSJF", "Base_WSJF", "Priority_Rank"):
            if task.get(field) is not None:
                try:
                    b.update_task_field(tid, field, task[field])
                except Exception:
                    pass

    return {"tasks": ranked, "critical_path": cp_ids, "critical_path_duration": cp_duration}


# ── Report ────────────────────────────────────────────────────────────────────

@app.get("/api/report")
def get_report():
    tasks = _b().read_all_tasks()
    if not tasks:
        return PlainTextResponse("No tasks.")
    try:
        ranked, cp_ids, cp_dur = run_full_analysis(tasks)
    except Exception:
        from ..algorithms.wsjf import rank_tasks
        ranked = rank_tasks(tasks)
        cp_ids, cp_dur = [], 0

    today = date.today().isoformat()
    active = [t for t in ranked if t.get("Status") not in ("Completed", "Deferred")]
    done = [t for t in tasks if t.get("Status") == "Completed"]

    lines = [f"# Priority Report — {today}", "",
             f"Active: {len(active)} | Completed: {len(done)}"]
    if cp_ids:
        lines += [f"Critical path: {' → '.join(cp_ids)} ({cp_dur} days)"]
    lines += ["", "| # | ID | Adj.WSJF | Status | Task |", "|---|---|---|---|---|"]
    for i, t in enumerate(active, 1):
        cp = " ★" if t.get("_on_critical_path") else ""
        lines.append(f"| {i} | {t.get('Task_ID','?')} | {t.get('Adjusted_WSJF','?')} "
                     f"| {t.get('Status','?')} | {t.get('Task_Name','')}{cp} |")
    if done:
        lines += ["", "## Completed", ""]
        for t in done:
            lines.append(f"- ~~{t.get('Task_Name','')}~~ `{t.get('Task_ID','')}`")
    lines += ["", "---", f"*Generated {today}*"]
    return PlainTextResponse("\n".join(lines))


# ── Seed / Clear ──────────────────────────────────────────────────────────────

@app.post("/api/seed")
def seed():
    b = _b()
    if b.read_all_tasks():
        return {"message": "already has data"}

    demos = [
        {"Task_Name": "Set up OAuth credentials for data pipeline", "Category": "Professional",
         "Value_Score": 2, "Time_Criticality": 5, "RR_OE_Score": 13, "Job_Size": 1,
         "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
         "Notes": "Blocks all downstream data work. Unlocks T-002, T-003, T-008."},
        {"Task_Name": "Build analytics dashboard for client reporting", "Category": "Professional",
         "Value_Score": 13, "Time_Criticality": 8, "RR_OE_Score": 5, "Job_Size": 8,
         "Duration_Days": 5, "Status": "Backlog", "Predecessor_IDs": "T-001",
         "Notes": "Client demo scheduled. Requires OAuth (T-001)."},
        {"Task_Name": "Automate monthly financial reports", "Category": "Professional",
         "Value_Score": 8, "Time_Criticality": 3, "RR_OE_Score": 5, "Job_Size": 5,
         "Duration_Days": 3, "Status": "Backlog", "Predecessor_IDs": "T-001",
         "Notes": "Saves ~8h/month once built. Also needs OAuth."},
        {"Task_Name": "Draft Q3 strategy memo for executive team", "Category": "Professional",
         "Value_Score": 8, "Time_Criticality": 13, "RR_OE_Score": 8, "Job_Size": 3,
         "Duration_Days": 2, "Status": "Backlog", "Predecessor_IDs": "",
         "Notes": "Board meeting in 10 days. Hard deadline."},
        {"Task_Name": "Migrate legacy customer database schema", "Category": "Professional",
         "Value_Score": 5, "Time_Criticality": 2, "RR_OE_Score": 8, "Job_Size": 13,
         "Duration_Days": 8, "Status": "Backlog", "Predecessor_IDs": "",
         "Notes": "Large task — Job_Size 13 triggers decomposition flag."},
        {"Task_Name": "Schedule annual physical and bloodwork", "Category": "Health",
         "Value_Score": 8, "Time_Criticality": 5, "RR_OE_Score": 3, "Job_Size": 1,
         "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
         "Notes": "10-minute task that keeps getting deferred."},
        {"Task_Name": "Renew business insurance policy", "Category": "Administrative",
         "Value_Score": 5, "Time_Criticality": 20, "RR_OE_Score": 2, "Job_Size": 2,
         "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
         "Notes": "Policy lapses in 3 weeks. High time criticality."},
        {"Task_Name": "Complete OAuth integration for client portal", "Category": "Professional",
         "Value_Score": 8, "Time_Criticality": 5, "RR_OE_Score": 5, "Job_Size": 3,
         "Duration_Days": 2, "Status": "Blocked", "Predecessor_IDs": "T-001",
         "Notes": "Blocked waiting for credentials (T-001)."},
    ]

    for d in demos:
        d["Base_WSJF"] = calculate_base_wsjf(
            d["Value_Score"], d["Time_Criticality"], d["RR_OE_Score"], d["Job_Size"])
        d["Adjusted_WSJF"] = d["Base_WSJF"]
        b.write_task(d)

    return {"seeded": len(demos)}


@app.delete("/api/all")
def clear_all():
    from ..storage.json_store import _save
    _save([])
    return {"cleared": True}


# ── Static file serving ───────────────────────────────────────────────────────

@app.get("/style.css")
def serve_css():
    return FileResponse(STATIC / "style.css", media_type="text/css")

@app.get("/app.js")
def serve_js():
    return FileResponse(STATIC / "app.js", media_type="application/javascript")

@app.get("/favicon.ico", status_code=204)
def favicon():
    return PlainTextResponse("")

@app.get("/{full_path:path}")
def spa(full_path: str):
    return FileResponse(STATIC / "index.html")
