"""
Priority CLI — main entry point for the prioritization engine.

Usage:
  python -m src.cli add "Task description"
  python -m src.cli list
  python -m src.cli analyze
  python -m src.cli decompose T-101
  python -m src.cli detect-bottlenecks
  python -m src.cli setup-sheet
  python -m src.cli report
  python -m src.cli update T-101 Status "In Progress"
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import date


def cmd_setup_sheet(args) -> None:
    from .sheets.setup import setup_sheet
    setup_sheet()


def cmd_add(args) -> None:
    """
    Add a new priority. Invokes evaluation-agent for WSJF scoring,
    then writes the result to Google Sheets via MCP.

    When running inside Claude Code, this command prints a structured prompt
    that Claude uses to trigger the evaluation-agent subagent.
    """
    description = " ".join(args.description)
    print(f"""
PRIORITY SYSTEM — ADD TASK
==========================
Task description: {description}

ACTION REQUIRED FOR CLAUDE:
1. Invoke the evaluation-agent subagent with the above description.
2. The agent will return a JSON object with pros, cons, and recommended WSJF scores.
3. If decompose_recommended is true (Job_Size >= 13), invoke decomposition-agent next.
4. Write the final scored task to Google Sheets using the MCP google-sheets tool.
5. Confirm the Task_ID assigned and print the score summary.

Pass this description to evaluation-agent:
  "{description}"
""")


def cmd_list(args) -> None:
    """List all priorities ranked by Adjusted_WSJF, reading from Google Sheets."""
    try:
        from .sheets.setup import read_all_tasks
        tasks = read_all_tasks()
    except Exception as e:
        print(f"Could not read from Google Sheets: {e}\n", file=sys.stderr)
        print("Tip: Run `python -m src.cli setup-sheet` to initialize the sheet first.")
        sys.exit(1)

    if not tasks:
        print("No tasks found. Add your first priority with:\n  python -m src.cli add \"Your goal here\"")
        return

    from .algorithms.wsjf import rank_tasks
    ranked = rank_tasks(tasks)

    print(f"\n{'#':>3}  {'Task_ID':<8}  {'Adj.WSJF':>8}  {'Status':<12}  Task")
    print("-" * 80)
    for i, task in enumerate(ranked, 1):
        cp_marker = " ★" if task.get("_on_critical_path") else ""
        decomp_marker = " ↓" if task.get("_decompose_flag") else ""
        print(
            f"{i:>3}  {task.get('Task_ID','?'):<8}  "
            f"{str(task.get('Adjusted_WSJF', task.get('Base_WSJF','?'))):>8}  "
            f"{str(task.get('Status','Backlog')):<12}  "
            f"{task.get('Task_Name','(no name)')}{cp_marker}{decomp_marker}"
        )

    print(f"\n★ = on critical path   ↓ = needs decomposition")
    print(f"\nTotal active tasks: {len(ranked)}")


def cmd_analyze(args) -> None:
    """
    Full re-sequencing analysis. Reads all tasks, recalculates Adjusted_WSJF,
    detects bottlenecks, and writes updated ranks back to Google Sheets.
    """
    try:
        from .sheets.setup import read_all_tasks, update_task_field
        tasks = read_all_tasks()
    except Exception as e:
        print(f"Could not read from Google Sheets: {e}", file=sys.stderr)
        sys.exit(1)

    if not tasks:
        print("No tasks to analyze.")
        return

    try:
        from .algorithms.scoring import run_full_analysis, explain_rank
        result = run_full_analysis(tasks)
        ranked, cp_ids, cp_duration = result
    except ValueError as e:
        print(f"Analysis failed:\n{e}", file=sys.stderr)
        sys.exit(1)

    print(f"\nANALYSIS COMPLETE")
    print(f"Critical path: {' → '.join(cp_ids)} ({cp_duration} days)")
    print(f"\nExecution queue ({len([t for t in ranked if t.get('Status') not in ('Completed','Deferred')])} active tasks):\n")

    for task in ranked:
        rank = task.get("Priority_Rank")
        if rank:
            print(explain_rank(task, rank))
            print()

    # Write Adjusted_WSJF and Priority_Rank back to sheet
    update_count = 0
    for task in ranked:
        tid = task.get("Task_ID")
        if not tid:
            continue
        try:
            if task.get("Adjusted_WSJF") is not None:
                update_task_field(tid, "Adjusted_WSJF", task["Adjusted_WSJF"])
            if task.get("Priority_Rank") is not None:
                update_task_field(tid, "Priority_Rank", task["Priority_Rank"])
            update_count += 1
        except Exception as e:
            print(f"  Warning: could not update {tid}: {e}")

    print(f"Updated {update_count} tasks in Google Sheets.")


def cmd_decompose(args) -> None:
    """
    Trigger task decomposition for a specific Task_ID.
    Prints structured prompt for Claude to invoke decomposition-agent.
    """
    task_id = args.task_id

    try:
        from .sheets.setup import read_all_tasks
        tasks = read_all_tasks()
        task = next((t for t in tasks if t.get("Task_ID") == task_id), None)
    except Exception:
        task = None

    if task:
        print(f"""
PRIORITY SYSTEM — DECOMPOSE TASK
=================================
Task_ID: {task_id}
Task_Name: {task.get('Task_Name', '(unknown)')}
Job_Size: {task.get('Job_Size', '(unknown)')}
Current Status: {task.get('Status', 'Backlog')}

ACTION REQUIRED FOR CLAUDE:
1. Invoke the decomposition-agent subagent with the above task details.
2. The agent will return a JSON array of subtask objects.
3. Validate each subtask has valid Fibonacci scores.
4. Write each subtask row to Google Sheets using the MCP google-sheets tool.
5. Update the parent task's Status to reflect it has been decomposed.
6. Re-run analyze to recalculate Adjusted_WSJF with the new subtasks.

Pass this to decomposition-agent:
{json.dumps(task, indent=2)}
""")
    else:
        print(f"""
PRIORITY SYSTEM — DECOMPOSE TASK
=================================
Task_ID: {task_id}
(Task not found in sheet — proceeding with ID only)

ACTION REQUIRED FOR CLAUDE:
1. Invoke the decomposition-agent subagent with Task_ID: {task_id}
2. Ask the user to describe the task if needed.
3. Write resulting subtask rows to Google Sheets.
""")


def cmd_detect_bottlenecks(args) -> None:
    """
    Invoke the dependency-detective analysis.
    Prints structured prompt for Claude to run the detective subagent.
    """
    try:
        from .sheets.setup import read_all_tasks
        tasks = read_all_tasks()
        task_count = len(tasks)
    except Exception:
        tasks = []
        task_count = 0

    print(f"""
PRIORITY SYSTEM — DETECT BOTTLENECKS
======================================
Tasks in sheet: {task_count}
Scan date: {date.today().isoformat()}

ACTION REQUIRED FOR CLAUDE:
1. Invoke the dependency-detective subagent with the full task list below.
2. The agent will return a JSON report with severity-rated issues.
3. For each CRITICAL or HIGH issue, present the resolution steps to the user.
4. Ask the user which issues to fix, then apply the changes via MCP.
5. Re-run analyze after fixes to recalculate the execution queue.

Pass the full task list to dependency-detective:
{json.dumps(tasks, indent=2)}
""")


def cmd_report(args) -> None:
    """Export current ranked queue as a markdown report."""
    try:
        from .sheets.setup import read_all_tasks
        tasks = read_all_tasks()
    except Exception as e:
        print(f"Could not read from Google Sheets: {e}", file=sys.stderr)
        sys.exit(1)

    from .algorithms.wsjf import rank_tasks
    ranked = rank_tasks(tasks)
    completed = [t for t in tasks if t.get("Status") == "Completed"]

    lines = [
        f"# Priority Report — {date.today().isoformat()}",
        "",
        f"**Active tasks**: {len(ranked)}  |  **Completed**: {len(completed)}",
        "",
        "## Execution Queue (highest Adjusted_WSJF first)",
        "",
        "| Rank | Task_ID | Adjusted WSJF | Status | Task |",
        "|------|---------|--------------|--------|------|",
    ]

    for i, task in enumerate(ranked, 1):
        cp = " ★" if task.get("_on_critical_path") else ""
        lines.append(
            f"| {i} | {task.get('Task_ID','?')} | {task.get('Adjusted_WSJF', '?')} "
            f"| {task.get('Status','Backlog')} | {task.get('Task_Name','')}{cp} |"
        )

    if completed:
        lines += ["", "## Completed", ""]
        for task in completed:
            lines.append(f"- ~~{task.get('Task_Name','')}~~ ({task.get('Task_ID','')})")

    lines += [
        "",
        "---",
        "★ = on critical path",
        f"*Generated by Priority engine on {date.today().isoformat()}*",
    ]

    report = "\n".join(lines)
    outfile = args.output if hasattr(args, "output") and args.output else f"report_{date.today().isoformat()}.md"
    with open(outfile, "w") as f:
        f.write(report)
    print(f"Report written to {outfile}")
    print(report)


def cmd_update(args) -> None:
    """Update a specific field on a task. Usage: update T-101 Status 'In Progress'"""
    from .sheets.setup import update_task_field
    try:
        update_task_field(args.task_id, args.field, args.value)
        print(f"Updated {args.task_id}.{args.field} = {args.value!r}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        prog="priority",
        description="AI-driven dependency-aware prioritization engine",
    )
    sub = parser.add_subparsers(dest="command")

    p_setup = sub.add_parser("setup-sheet", help="Initialize or validate the Google Sheet schema")
    p_setup.set_defaults(func=cmd_setup_sheet)

    p_add = sub.add_parser("add", help="Add a new priority (triggers evaluation-agent)")
    p_add.add_argument("description", nargs="+", help="Natural language description of the priority")
    p_add.set_defaults(func=cmd_add)

    p_list = sub.add_parser("list", help="List priorities ranked by Adjusted_WSJF")
    p_list.set_defaults(func=cmd_list)

    p_analyze = sub.add_parser("analyze", help="Full re-sequencing analysis")
    p_analyze.set_defaults(func=cmd_analyze)

    p_decompose = sub.add_parser("decompose", help="Decompose a large task into subtasks")
    p_decompose.add_argument("task_id", help="Task_ID to decompose (e.g. T-101)")
    p_decompose.set_defaults(func=cmd_decompose)

    p_detect = sub.add_parser("detect-bottlenecks", help="Run dependency-detective scan")
    p_detect.set_defaults(func=cmd_detect_bottlenecks)

    p_report = sub.add_parser("report", help="Export ranked queue as markdown")
    p_report.add_argument("--output", "-o", help="Output filename (default: report_YYYY-MM-DD.md)")
    p_report.set_defaults(func=cmd_report)

    p_update = sub.add_parser("update", help="Update a specific field on a task")
    p_update.add_argument("task_id", help="Task_ID (e.g. T-101)")
    p_update.add_argument("field", help="Column name (e.g. Status)")
    p_update.add_argument("value", help="New value")
    p_update.set_defaults(func=cmd_update)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    args.func(args)


if __name__ == "__main__":
    main()
