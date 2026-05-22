"""Bottleneck scoring, priority inflation, and full re-sequencing pipeline."""

from __future__ import annotations
from typing import Any

from .wsjf import calculate_base_wsjf, calculate_adjusted_wsjf, needs_decomposition
from .dag import build_graph, detect_cycles, find_critical_path, successor_count


BOTTLENECK_INFLATE_THRESHOLD = 50   # bottleneck_score above this overrides WSJF rank
BOTTLENECK_INFLATE_BONUS = 25.0     # flat Adjusted_WSJF bonus for qualifying bottlenecks


def calculate_bottleneck_score(
    frequency: int,  # 1–5: how often does this task block progress?
    impact: int,     # 1–5: how severe is the blockage when it occurs?
    solvability: int # 1–5: how much control does the user have over resolving it?
) -> int:
    """Bottleneck Score = Frequency × Impact × Solvability. Max = 125."""
    for name, val in [("frequency", frequency), ("impact", impact), ("solvability", solvability)]:
        if not (1 <= val <= 5):
            raise ValueError(f"{name} must be between 1 and 5, got {val}")
    return frequency * impact * solvability


def run_full_analysis(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Complete re-sequencing pipeline:
    1. Validate DAG (no cycles)
    2. Calculate Base_WSJF for any task missing it
    3. Calculate Adjusted_WSJF (domino effect rollup)
    4. Apply bottleneck inflation
    5. Find critical path
    6. Return tasks sorted by Adjusted_WSJF descending

    This is the function Claude calls via `python -m src.cli analyze`.
    """
    if not tasks:
        return []

    cycles = detect_cycles(build_graph(tasks))
    if cycles:
        cycle_strs = [" → ".join(c) for c in cycles]
        raise ValueError(
            f"Circular dependencies detected — cannot sequence until resolved:\n"
            + "\n".join(f"  {c}" for c in cycle_strs)
        )

    task_index: dict[str, dict[str, Any]] = {t["Task_ID"]: t for t in tasks if t.get("Task_ID")}
    graph = build_graph(tasks)

    # Pass 1: ensure Base_WSJF is populated
    for task in tasks:
        tid = task.get("Task_ID")
        if not tid:
            continue
        try:
            task["Base_WSJF"] = calculate_base_wsjf(
                int(task.get("Value_Score") or 0),
                int(task.get("Time_Criticality") or 0),
                int(task.get("RR_OE_Score") or 0),
                int(task.get("Job_Size") or 1),
            )
        except (ValueError, ZeroDivisionError):
            pass  # Tasks with incomplete scores keep their existing Base_WSJF

    # Pass 2: Adjusted_WSJF (requires Base_WSJF to be set first)
    for task in tasks:
        tid = task.get("Task_ID")
        if not tid:
            continue
        base = task.get("Base_WSJF", 0.0)
        task["Adjusted_WSJF"] = calculate_adjusted_wsjf(tid, base, graph, task_index)

    # Pass 3: bottleneck inflation
    succ_counts = successor_count(graph)
    for task in tasks:
        tid = task.get("Task_ID")
        if not tid:
            continue
        bs = task.get("Bottleneck_Score")
        if bs and int(bs) > BOTTLENECK_INFLATE_THRESHOLD:
            task["Adjusted_WSJF"] = round(
                task.get("Adjusted_WSJF", 0.0) + BOTTLENECK_INFLATE_BONUS, 2
            )

        # Auto-flag tasks that block many successors but have undersized RR_OE
        count = succ_counts.get(tid, 0)
        rr = int(task.get("RR_OE_Score") or 0)
        if count >= 3 and rr < 5:
            task["_bottleneck_flag"] = (
                f"Blocks {count} successors but RR_OE_Score={rr}. "
                f"Consider rescoring RR_OE to at least 8."
            )

    # Pass 4: flag tasks needing decomposition
    for task in tasks:
        js = task.get("Job_Size")
        if js and needs_decomposition(int(js)):
            task["_decompose_flag"] = True

    # Pass 5: critical path
    cp_ids, cp_duration = find_critical_path(graph, task_index)
    for task in tasks:
        task["_on_critical_path"] = task.get("Task_ID") in cp_ids

    # Sort active tasks by Adjusted_WSJF descending
    active = [
        t for t in tasks
        if t.get("Status") not in ("Completed", "Deferred")
    ]
    completed = [
        t for t in tasks
        if t.get("Status") in ("Completed", "Deferred")
    ]

    ranked = sorted(active, key=lambda t: (t.get("Adjusted_WSJF", 0.0), t.get("Base_WSJF", 0.0)), reverse=True)

    for i, task in enumerate(ranked):
        task["Priority_Rank"] = i + 1

    return ranked + completed, cp_ids, cp_duration


def explain_rank(task: dict[str, Any], rank: int) -> str:
    """Plain-language explanation of why a task holds a given rank."""
    lines = [
        f"#{rank}: {task.get('Task_Name', task.get('Task_ID'))}",
        f"  Adjusted WSJF: {task.get('Adjusted_WSJF', 'N/A')} (Base: {task.get('Base_WSJF', 'N/A')})",
    ]

    flag = task.get("_bottleneck_flag")
    if flag:
        lines.append(f"  ⚠ Bottleneck: {flag}")

    if task.get("_on_critical_path"):
        lines.append("  ★ On critical path — any delay here delays the entire queue")

    if task.get("_decompose_flag"):
        lines.append("  ↓ Job_Size >= 13 — decomposition recommended before scheduling")

    bs = task.get("Bottleneck_Score")
    if bs and int(bs) > BOTTLENECK_INFLATE_THRESHOLD:
        lines.append(f"  ↑ Bottleneck score {bs} > {BOTTLENECK_INFLATE_THRESHOLD} — priority inflated")

    return "\n".join(lines)
