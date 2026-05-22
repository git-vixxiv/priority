"""WSJF scoring engine — all prioritization math lives here."""

from __future__ import annotations
from typing import Any

FIBONACCI_SCALE = {1, 2, 3, 5, 8, 13, 20, 40, 100}
DECOMPOSE_THRESHOLD = 13  # Job_Size >= this triggers mandatory decomposition
DOWNSTREAM_WEIGHT = 0.5   # How much successor WSJF rolls up into Adjusted_WSJF


def validate_fibonacci(value: int | float, field: str) -> int:
    v = int(value)
    if v not in FIBONACCI_SCALE:
        raise ValueError(
            f"{field} must be a Fibonacci scale value (1,2,3,5,8,13,20,40,100), got {v}"
        )
    return v


def calculate_base_wsjf(
    value_score: int,
    time_criticality: int,
    rr_oe_score: int,
    job_size: int,
) -> float:
    """Base_WSJF = (Value + Time_Criticality + RR_OE) / Job_Size"""
    validate_fibonacci(value_score, "Value_Score")
    validate_fibonacci(time_criticality, "Time_Criticality")
    validate_fibonacci(rr_oe_score, "RR_OE_Score")
    validate_fibonacci(job_size, "Job_Size")
    cost_of_delay = value_score + time_criticality + rr_oe_score
    return round(cost_of_delay / job_size, 2)


def calculate_adjusted_wsjf(
    task_id: str,
    base_wsjf: float,
    graph: dict[str, set[str]],
    task_index: dict[str, dict[str, Any]],
) -> float:
    """
    Adjusted_WSJF = Base_WSJF + (DOWNSTREAM_WEIGHT * sum of all descendant Base_WSJFs)

    This is the domino effect: a tiny task that unblocks huge downstream work
    gets a much higher Adjusted_WSJF than its Base_WSJF alone would suggest.
    """
    visited: set[str] = set()
    queue: list[str] = list(graph.get(task_id, set()))
    downstream_total = 0.0

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        task = task_index.get(current)
        if task:
            downstream_total += task.get("Base_WSJF", 0.0)
        for successor in graph.get(current, set()):
            if successor not in visited:
                queue.append(successor)

    return round(base_wsjf + DOWNSTREAM_WEIGHT * downstream_total, 2)


def needs_decomposition(job_size: int) -> bool:
    return job_size >= DECOMPOSE_THRESHOLD


def rank_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Sort tasks by Adjusted_WSJF descending, breaking ties with Base_WSJF.
    Excludes Completed and Deferred tasks from the active queue.
    """
    active = [
        t for t in tasks
        if t.get("Status") not in ("Completed", "Deferred")
    ]
    return sorted(
        active,
        key=lambda t: (t.get("Adjusted_WSJF", 0.0), t.get("Base_WSJF", 0.0)),
        reverse=True,
    )


def score_summary(task: dict[str, Any]) -> str:
    """Human-readable one-line score summary for a task."""
    vs = task.get("Value_Score", "?")
    tc = task.get("Time_Criticality", "?")
    rr = task.get("RR_OE_Score", "?")
    js = task.get("Job_Size", "?")
    bw = task.get("Base_WSJF", "?")
    aw = task.get("Adjusted_WSJF", "?")
    return f"V={vs} T={tc} R={rr} / J={js} → Base={bw} Adj={aw}"
