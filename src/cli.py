"""
Priority CLI — AI-driven dependency-aware prioritization engine.

Usage:
  python -m src.cli setup-sheet
  python -m src.cli add "Task description" [--value N] [--time N] [--rr N] [--size N]
  python -m src.cli list
  python -m src.cli analyze
  python -m src.cli decompose T-101
  python -m src.cli detect-bottlenecks
  python -m src.cli report [--output FILE]
  python -m src.cli update T-101 Status "In Progress"
  python -m src.cli seed
  python -m src.cli show T-101
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import date

from .storage.backend import get_backend
from .algorithms.wsjf import calculate_base_wsjf, needs_decomposition, score_summary
from .sheets.schema import FIBONACCI_SCALE


# ── helpers ──────────────────────────────────────────────────────────────────

def _backend():
    return get_backend()


def _is_sheets() -> bool:
    return bool(os.environ.get("PRIORITY_SPREADSHEET_ID"))


def _storage_label() -> str:
    return "Google Sheets" if _is_sheets() else f"local JSON ({_data_path()})"


def _data_path() -> str:
    import os
    env = os.environ.get("PRIORITY_JSON_PATH")
    if env:
        return env
    from pathlib import Path
    return str(Path(__file__).parent.parent / "data" / "priorities.json")


def _validate_fib(val: int, name: str) -> None:
    if val not in FIBONACCI_SCALE:
        print(f"Error: {name}={val} is not a valid Fibonacci scale value.")
        print(f"  Valid values: 1, 2, 3, 5, 8, 13, 20, 40, 100")
        sys.exit(1)


# ── commands ─────────────────────────────────────────────────────────────────

def cmd_setup_sheet(args) -> None:
    _backend().setup_sheet()


def cmd_add(args) -> None:
    description = " ".join(args.description)

    # If scores are provided via flags, write directly
    if any(x is not None for x in [args.value, args.time, args.rr, args.size]):
        vs = args.value or 3
        tc = args.time or 3
        rr = args.rr or 3
        js = args.size or 3
        for val, name in [(vs, "value"), (tc, "time"), (rr, "rr"), (js, "size")]:
            _validate_fib(val, name)

        base = calculate_base_wsjf(vs, tc, rr, js)
        task = {
            "Task_Name": description,
            "Value_Score": vs,
            "Time_Criticality": tc,
            "RR_OE_Score": rr,
            "Job_Size": js,
            "Base_WSJF": base,
            "Adjusted_WSJF": base,  # will be updated on next analyze
            "Status": "Backlog",
            "Predecessor_IDs": args.predecessors or "",
            "Duration_Days": args.duration or "",
            "Category": args.category or "",
            "Notes": args.notes or "",
        }
        if needs_decomposition(js):
            print(f"Note: Job_Size={js} >= 13 — decomposition recommended before scheduling.")

        tid = _backend().write_task(task)
        print(f"Added {tid}: {description}")
        print(f"  {score_summary(task)}")
        print(f"  Run `python -m src.cli analyze` to recalculate the full execution queue.")

    else:
        # No scores — print evaluation-agent prompt for Claude to handle
        print(f"""
PRIORITY SYSTEM — EVALUATE & ADD TASK
=======================================
Description: {description}

Invoke evaluation-agent with this description, then call:
  python -m src.cli add "{description}" \\
    --value VALUE_SCORE --time TIME_CRITICALITY --rr RR_OE_SCORE --size JOB_SIZE

Or add with default scores (all 3s) and edit later:
  python -m src.cli add "{description}" --value 3 --time 3 --rr 3 --size 3
""")


def cmd_list(args) -> None:
    try:
        tasks = _backend().read_all_tasks()
    except Exception as e:
        print(f"Could not read tasks: {e}", file=sys.stderr)
        sys.exit(1)

    if not tasks:
        print(f"No tasks found in {_storage_label()}.")
        print("Add your first priority:")
        print('  python -m src.cli add "Your goal" --value 5 --time 3 --rr 8 --size 3')
        print("Or load example tasks:")
        print("  python -m src.cli seed")
        return

    from .algorithms.wsjf import rank_tasks
    ranked = rank_tasks(tasks)
    completed = [t for t in tasks if t.get("Status") == "Completed"]
    deferred = [t for t in tasks if t.get("Status") == "Deferred"]

    print(f"\nStorage: {_storage_label()}")
    print(f"Active: {len(ranked)}  |  Completed: {len(completed)}  |  Deferred: {len(deferred)}\n")
    print(f"{'#':>3}  {'ID':<8}  {'Adj.WSJF':>8}  {'Base':>6}  {'Status':<12}  {'CP':2}  Task")
    print("─" * 90)

    for i, task in enumerate(ranked, 1):
        cp = "★" if task.get("_on_critical_path") else " "
        dec = "↓" if task.get("_decompose_flag") else " "
        adj = task.get("Adjusted_WSJF") or task.get("Base_WSJF") or "?"
        base = task.get("Base_WSJF") or "?"
        status = task.get("Status") or "Backlog"
        name = task.get("Task_Name") or "(no name)"
        tid = task.get("Task_ID") or "?"
        print(f"{i:>3}  {tid:<8}  {str(adj):>8}  {str(base):>6}  {status:<12}  {cp}{dec}  {name}")

    print()
    if any(t.get("_on_critical_path") for t in ranked):
        print("★ = on critical path")
    if any(t.get("_decompose_flag") for t in ranked):
        print("↓ = Job_Size ≥ 13, decomposition recommended")


def cmd_show(args) -> None:
    tasks = _backend().read_all_tasks()
    task = next((t for t in tasks if t.get("Task_ID") == args.task_id), None)
    if not task:
        print(f"Task {args.task_id} not found.")
        sys.exit(1)

    print(f"\n{task.get('Task_ID')}: {task.get('Task_Name')}")
    print(f"  Status:      {task.get('Status', 'Backlog')}")
    print(f"  Category:    {task.get('Category', '')}")
    print(f"  Scores:      {score_summary(task)}")
    print(f"  Duration:    {task.get('Duration_Days', '?')} days")
    print(f"  Predecessors:{task.get('Predecessor_IDs', 'none')}")
    print(f"  Successors:  {task.get('Successor_IDs', 'none')}")
    print(f"  Critical path: {'yes ★' if task.get('_on_critical_path') else 'no'}")
    if task.get("Notes"):
        print(f"  Notes:       {task.get('Notes')}")
    if task.get("Pros"):
        print(f"  Pros:        {task.get('Pros')}")
    if task.get("Cons"):
        print(f"  Cons:        {task.get('Cons')}")


def cmd_analyze(args) -> None:
    try:
        tasks = _backend().read_all_tasks()
    except Exception as e:
        print(f"Could not read tasks: {e}", file=sys.stderr)
        sys.exit(1)

    if not tasks:
        print("No tasks to analyze.")
        return

    try:
        from .algorithms.scoring import run_full_analysis, explain_rank
        ranked, cp_ids, cp_duration = run_full_analysis(tasks)
    except ValueError as e:
        print(f"Analysis failed:\n{e}", file=sys.stderr)
        sys.exit(1)

    active = [t for t in ranked if t.get("Priority_Rank")]
    print(f"\nANALYSIS COMPLETE — {len(active)} active tasks")
    print(f"Critical path: {' → '.join(cp_ids) if cp_ids else 'none'} ({cp_duration} days)\n")

    for task in active:
        print(explain_rank(task, task["Priority_Rank"]))
        print()

    # Persist updated scores
    updated = 0
    for task in ranked:
        tid = task.get("Task_ID")
        if not tid:
            continue
        try:
            if task.get("Adjusted_WSJF") is not None:
                _backend().update_task_field(tid, "Adjusted_WSJF", task["Adjusted_WSJF"])
            if task.get("Base_WSJF") is not None:
                _backend().update_task_field(tid, "Base_WSJF", task["Base_WSJF"])
            if task.get("Priority_Rank") is not None:
                _backend().update_task_field(tid, "Priority_Rank", task["Priority_Rank"])
            updated += 1
        except Exception as e:
            print(f"  Warning: could not update {tid}: {e}")

    print(f"Scores written back to {_storage_label()} ({updated} tasks updated).")

    decomp = [t for t in active if t.get("_decompose_flag")]
    if decomp:
        print(f"\nTasks needing decomposition (Job_Size ≥ 13):")
        for t in decomp:
            print(f"  {t['Task_ID']}: {t.get('Task_Name')} — run: python -m src.cli decompose {t['Task_ID']}")

    bottlenecks = [t for t in active if t.get("_bottleneck_flag")]
    if bottlenecks:
        print(f"\nBottleneck warnings:")
        for t in bottlenecks:
            print(f"  {t['Task_ID']}: {t.get('_bottleneck_flag')}")


def cmd_decompose(args) -> None:
    tasks = _backend().read_all_tasks()
    task = next((t for t in tasks if t.get("Task_ID") == args.task_id), None)

    if task:
        print(f"""
PRIORITY SYSTEM — DECOMPOSE TASK
=================================
Task_ID:  {args.task_id}
Name:     {task.get('Task_Name', '(unknown)')}
Job_Size: {task.get('Job_Size', '?')}
Status:   {task.get('Status', 'Backlog')}

Invoke decomposition-agent with the task below, then add each subtask with:
  python -m src.cli add "Subtask name" --value V --time T --rr R --size S \\
    --predecessors "PARENT_ID or prior subtask"

Parent task JSON:
{json.dumps(task, indent=2)}
""")
    else:
        print(f"Task {args.task_id} not found. Check the ID with: python -m src.cli list")


def cmd_detect_bottlenecks(args) -> None:
    tasks = _backend().read_all_tasks()

    if not tasks:
        print("No tasks to scan.")
        return

    # Run local analysis first to surface quick wins
    try:
        from .algorithms.scoring import run_full_analysis
        ranked, cp_ids, cp_duration = run_full_analysis(tasks)
    except ValueError as e:
        print(f"DAG error:\n{e}", file=sys.stderr)
        sys.exit(1)

    from .algorithms.dag import build_graph, detect_cycles, successor_count
    graph = build_graph(tasks)
    cycles = detect_cycles(graph)
    succ_counts = successor_count(graph)
    task_index = {t["Task_ID"]: t for t in tasks if t.get("Task_ID")}

    print(f"\nDEPENDENCY SCAN — {len(tasks)} tasks\n")

    if cycles:
        print("CRITICAL — Circular dependencies detected:")
        for c in cycles:
            print(f"  {' → '.join(c)}")
        print()

    # Orphaned tasks
    orphans = [
        t for t in tasks
        if not t.get("Predecessor_IDs") and not succ_counts.get(t.get("Task_ID"), 0)
        and not t.get("Parent_ID")
        and t.get("Status") not in ("Completed", "Deferred")
    ]
    if orphans:
        print("MEDIUM — Orphaned tasks (no dependencies, may be missing links):")
        for t in orphans:
            print(f"  {t['Task_ID']}: {t.get('Task_Name')}")
        print()

    # Bottleneck candidates
    bottlenecks = [
        (tid, count) for tid, count in succ_counts.items()
        if count >= 3
    ]
    if bottlenecks:
        print("HIGH — Tasks blocking 3+ successors (check RR_OE_Score):")
        for tid, count in sorted(bottlenecks, key=lambda x: -x[1]):
            t = task_index.get(tid, {})
            rr = t.get("RR_OE_Score", "?")
            print(f"  {tid}: {t.get('Task_Name', '?')} — blocks {count}, RR_OE={rr}")
        print()

    # Stale blocked status
    stale = []
    for task in tasks:
        if task.get("Status") != "Blocked":
            continue
        preds = [p.strip() for p in (task.get("Predecessor_IDs") or "").split(",") if p.strip()]
        all_done = all(task_index.get(p, {}).get("Status") == "Completed" for p in preds if p)
        if preds and all_done:
            stale.append(task)
    if stale:
        print("LOW — Tasks still marked Blocked but all predecessors are Completed:")
        for t in stale:
            print(f"  {t['Task_ID']}: {t.get('Task_Name')} — update status to Backlog")
        print()

    if cp_ids:
        print(f"Critical path ({cp_duration} days): {' → '.join(cp_ids)}")
        print()

    if not cycles and not orphans and not bottlenecks and not stale:
        print("No issues found. DAG is clean.")

    print("\nFor full dependency-detective analysis, invoke the subagent with:")
    print(f"  {len(tasks)} tasks passed to dependency-detective")


def cmd_report(args) -> None:
    try:
        tasks = _backend().read_all_tasks()
    except Exception as e:
        print(f"Could not read tasks: {e}", file=sys.stderr)
        sys.exit(1)

    if not tasks:
        print("No tasks to report on.")
        return

    # Run analysis to get fresh scores
    try:
        from .algorithms.scoring import run_full_analysis
        ranked, cp_ids, cp_duration = run_full_analysis(tasks)
    except ValueError:
        from .algorithms.wsjf import rank_tasks
        ranked = rank_tasks(tasks)
        cp_ids, cp_duration = [], 0

    active = [t for t in ranked if t.get("Status") not in ("Completed", "Deferred")]
    completed = [t for t in tasks if t.get("Status") == "Completed"]

    today = date.today().isoformat()
    lines = [
        f"# Priority Report — {today}",
        "",
        f"**Active**: {len(active)}  |  **Completed**: {len(completed)}",
    ]

    if cp_ids:
        lines += [f"**Critical path**: {' → '.join(cp_ids)} ({cp_duration} days)", ""]

    lines += [
        "## Execution Queue",
        "",
        "| # | ID | Adj.WSJF | Status | Task |",
        "|---|-----|---------|--------|------|",
    ]

    for i, task in enumerate(active, 1):
        cp = " ★" if task.get("_on_critical_path") else ""
        dec = " ↓" if task.get("_decompose_flag") else ""
        adj = task.get("Adjusted_WSJF") or task.get("Base_WSJF") or "?"
        lines.append(
            f"| {i} | {task.get('Task_ID','?')} | {adj} "
            f"| {task.get('Status','Backlog')} | {task.get('Task_Name','')}{cp}{dec} |"
        )

    if completed:
        lines += ["", "## Completed", ""]
        for t in completed:
            lines.append(f"- ~~{t.get('Task_Name','')}~~ `{t.get('Task_ID','')}`")

    lines += [
        "", "---",
        "★ = on critical path  ↓ = decomposition recommended",
        f"*Generated {today}*",
    ]

    report = "\n".join(lines)
    outfile = (args.output if hasattr(args, "output") and args.output
               else f"report_{today}.md")
    with open(outfile, "w") as f:
        f.write(report)

    print(report)
    print(f"\nSaved to {outfile}")


def cmd_update(args) -> None:
    try:
        _backend().update_task_field(args.task_id, args.field, args.value)
        print(f"Updated {args.task_id}.{args.field} = {args.value!r}")
        print("Run `python -m src.cli analyze` to recalculate the execution queue.")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_seed(args) -> None:
    """Load realistic demo tasks to exercise the full system."""
    demo_tasks = [
        {
            "Task_Name": "Set up Google OAuth credentials for data pipeline",
            "Category": "Professional",
            "Value_Score": 2, "Time_Criticality": 5, "RR_OE_Score": 13, "Job_Size": 1,
            "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
            "Notes": "Blocks all downstream data work. Fast to do, high unlock value.",
        },
        {
            "Task_Name": "Build analytics dashboard for client reporting",
            "Category": "Professional",
            "Value_Score": 13, "Time_Criticality": 8, "RR_OE_Score": 5, "Job_Size": 8,
            "Duration_Days": 5, "Status": "Backlog", "Predecessor_IDs": "T-001",
            "Notes": "Client demo scheduled. Requires OAuth (T-001) to connect to data source.",
        },
        {
            "Task_Name": "Automate monthly financial reports",
            "Category": "Professional",
            "Value_Score": 8, "Time_Criticality": 3, "RR_OE_Score": 5, "Job_Size": 5,
            "Duration_Days": 3, "Status": "Backlog", "Predecessor_IDs": "T-001",
            "Notes": "Saves ~8h/month once built. Also needs OAuth.",
        },
        {
            "Task_Name": "Draft Q3 strategy memo for executive team",
            "Category": "Professional",
            "Value_Score": 8, "Time_Criticality": 13, "RR_OE_Score": 8, "Job_Size": 3,
            "Duration_Days": 2, "Status": "Backlog", "Predecessor_IDs": "",
            "Notes": "Board meeting in 10 days. Hard deadline.",
        },
        {
            "Task_Name": "Migrate legacy customer database schema",
            "Category": "Professional",
            "Value_Score": 5, "Time_Criticality": 2, "RR_OE_Score": 8, "Job_Size": 13,
            "Duration_Days": 8, "Status": "Backlog", "Predecessor_IDs": "",
            "Notes": "Large task — Job_Size=13 will trigger decomposition flag.",
        },
        {
            "Task_Name": "Schedule annual physical and bloodwork",
            "Category": "Health",
            "Value_Score": 8, "Time_Criticality": 5, "RR_OE_Score": 3, "Job_Size": 1,
            "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
            "Notes": "10-minute task that keeps getting deferred.",
        },
        {
            "Task_Name": "Renew business insurance policy",
            "Category": "Administrative",
            "Value_Score": 5, "Time_Criticality": 20, "RR_OE_Score": 2, "Job_Size": 2,
            "Duration_Days": 1, "Status": "Backlog", "Predecessor_IDs": "",
            "Notes": "Policy lapses in 3 weeks. High time criticality.",
        },
        {
            "Task_Name": "Complete OAuth integration for client portal",
            "Category": "Professional",
            "Value_Score": 8, "Time_Criticality": 5, "RR_OE_Score": 5, "Job_Size": 3,
            "Duration_Days": 2, "Status": "Blocked", "Predecessor_IDs": "T-001",
            "Notes": "Blocked waiting for credentials (T-001).",
        },
    ]

    b = _backend()
    existing = b.read_all_tasks()
    if existing and not args.force:
        print(f"Storage already has {len(existing)} tasks. Use --force to overwrite.")
        return

    if args.force:
        # Clear existing tasks
        from .storage.json_store import _save
        _save([])

    for task in demo_tasks:
        tid = b.write_task(task)
        base = calculate_base_wsjf(
            task["Value_Score"], task["Time_Criticality"],
            task["RR_OE_Score"], task["Job_Size"]
        )
        print(f"  {tid}: {task['Task_Name'][:50]} — Base WSJF {base}")

    print(f"\nSeeded {len(demo_tasks)} tasks. Now run:")
    print("  python -m src.cli analyze    # full re-sequencing with domino effect")
    print("  python -m src.cli list       # ranked execution queue")
    print("  python -m src.cli report     # markdown report")


# ── arg parser ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="priority",
        description="AI-driven dependency-aware prioritization engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    # setup-sheet
    p = sub.add_parser("setup-sheet", help="Initialize storage (JSON or Google Sheets)")
    p.set_defaults(func=cmd_setup_sheet)

    # add
    p = sub.add_parser("add", help="Add a new priority")
    p.add_argument("description", nargs="+")
    p.add_argument("--value", "-v",   type=int, help="Value_Score (Fibonacci)")
    p.add_argument("--time",  "-t",   type=int, help="Time_Criticality (Fibonacci)")
    p.add_argument("--rr",    "-r",   type=int, help="RR_OE_Score (Fibonacci)")
    p.add_argument("--size",  "-s",   type=int, help="Job_Size (Fibonacci)")
    p.add_argument("--predecessors",  help="Comma-separated predecessor Task_IDs")
    p.add_argument("--duration",      type=int, help="Duration in days")
    p.add_argument("--category",      help="Category label")
    p.add_argument("--notes",         help="Free-form notes")
    p.set_defaults(func=cmd_add)

    # list
    p = sub.add_parser("list", help="List priorities ranked by Adjusted_WSJF")
    p.set_defaults(func=cmd_list)

    # show
    p = sub.add_parser("show", help="Show full detail for one task")
    p.add_argument("task_id")
    p.set_defaults(func=cmd_show)

    # analyze
    p = sub.add_parser("analyze", help="Full re-sequencing analysis")
    p.set_defaults(func=cmd_analyze)

    # decompose
    p = sub.add_parser("decompose", help="Decompose a large task (Job_Size ≥ 13)")
    p.add_argument("task_id")
    p.set_defaults(func=cmd_decompose)

    # detect-bottlenecks
    p = sub.add_parser("detect-bottlenecks", help="Scan dependency graph for issues")
    p.set_defaults(func=cmd_detect_bottlenecks)

    # report
    p = sub.add_parser("report", help="Export ranked queue as markdown")
    p.add_argument("--output", "-o")
    p.set_defaults(func=cmd_report)

    # update
    p = sub.add_parser("update", help="Update a field on a task")
    p.add_argument("task_id")
    p.add_argument("field")
    p.add_argument("value")
    p.set_defaults(func=cmd_update)

    # seed
    p = sub.add_parser("seed", help="Load demo tasks for testing")
    p.add_argument("--force", action="store_true", help="Overwrite existing tasks")
    p.set_defaults(func=cmd_seed)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    args.func(args)


if __name__ == "__main__":
    main()
