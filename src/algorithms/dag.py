"""Directed Acyclic Graph construction, cycle detection, topological sort, and CPM."""

from __future__ import annotations
from collections import deque
from typing import Any


def build_graph(tasks: list[dict[str, Any]]) -> dict[str, set[str]]:
    """
    Build adjacency list: task_id → set of direct successors.
    Derived from each task's Predecessor_IDs field.
    """
    ids = {t["Task_ID"] for t in tasks if t.get("Task_ID")}
    graph: dict[str, set[str]] = {tid: set() for tid in ids}

    for task in tasks:
        tid = task.get("Task_ID")
        if not tid:
            continue
        raw = task.get("Predecessor_IDs") or ""
        for pred in _split_ids(raw):
            if pred in graph:
                graph[pred].add(tid)
            # If predecessor isn't in the dataset, still register the node
            else:
                graph.setdefault(pred, set()).add(tid)

    return graph


def build_reverse_graph(graph: dict[str, set[str]]) -> dict[str, set[str]]:
    """Invert the graph: task_id → set of direct predecessors."""
    reverse: dict[str, set[str]] = {node: set() for node in graph}
    for node, successors in graph.items():
        for s in successors:
            reverse.setdefault(s, set()).add(node)
    return reverse


def detect_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    """
    DFS-based cycle detection. Returns list of cycles (each cycle is a list of node IDs).
    An empty list means the graph is a valid DAG.
    """
    visited: set[str] = set()
    rec_stack: set[str] = set()
    cycles: list[list[str]] = []

    def dfs(node: str, path: list[str]) -> None:
        visited.add(node)
        rec_stack.add(node)
        path.append(node)

        for successor in graph.get(node, set()):
            if successor not in visited:
                dfs(successor, path)
            elif successor in rec_stack:
                # Found a cycle — capture the loop portion
                cycle_start = path.index(successor)
                cycles.append(list(path[cycle_start:]))

        path.pop()
        rec_stack.discard(node)

    for node in list(graph):
        if node not in visited:
            dfs(node, [])

    return cycles


def topological_sort(graph: dict[str, set[str]]) -> list[str]:
    """
    Kahn's algorithm. Returns nodes in dependency order (predecessors before successors).
    Raises ValueError if a cycle is present.
    """
    in_degree: dict[str, int] = {node: 0 for node in graph}
    for node in graph:
        for successor in graph[node]:
            in_degree[successor] = in_degree.get(successor, 0) + 1

    queue: deque[str] = deque(n for n, d in in_degree.items() if d == 0)
    result: list[str] = []

    while queue:
        node = queue.popleft()
        result.append(node)
        for successor in sorted(graph.get(node, set())):  # sorted for determinism
            in_degree[successor] -= 1
            if in_degree[successor] == 0:
                queue.append(successor)

    if len(result) != len(graph):
        raise ValueError("Cycle detected — cannot produce a topological sort.")

    return result


def find_critical_path(
    graph: dict[str, set[str]],
    task_index: dict[str, dict[str, Any]],
) -> tuple[list[str], int]:
    """
    Forward pass CPM. Returns (critical_path_node_ids, total_duration_days).

    The critical path is the longest sequence of dependent tasks by Duration_Days.
    Any delay on this path delays everything downstream.
    """
    try:
        order = topological_sort(graph)
    except ValueError:
        return [], 0

    earliest_finish: dict[str, int] = {}

    for node in order:
        task = task_index.get(node, {})
        duration = int(task.get("Duration_Days") or 1)
        preds = _predecessors_of(node, graph)
        if preds:
            earliest_start = max(earliest_finish.get(p, 0) for p in preds)
        else:
            earliest_start = 0
        earliest_finish[node] = earliest_start + duration

    if not earliest_finish:
        return [], 0

    # Trace back from the node with the latest finish time
    end_node = max(earliest_finish, key=lambda n: earliest_finish[n])
    total_duration = earliest_finish[end_node]

    path: list[str] = []
    current = end_node
    reverse = build_reverse_graph(graph)

    while current:
        path.append(current)
        preds = list(reverse.get(current, set()))
        if not preds:
            break
        # Follow the predecessor with the highest earliest_finish (the bottleneck pred)
        current = max(preds, key=lambda p: earliest_finish.get(p, 0))

    path.reverse()
    return path, total_duration


def get_all_descendants(task_id: str, graph: dict[str, set[str]]) -> set[str]:
    """BFS to collect all transitive successors of a task."""
    visited: set[str] = set()
    queue: deque[str] = deque(graph.get(task_id, set()))
    while queue:
        node = queue.popleft()
        if node in visited:
            continue
        visited.add(node)
        queue.extend(graph.get(node, set()) - visited)
    return visited


def get_all_ancestors(task_id: str, graph: dict[str, set[str]]) -> set[str]:
    """BFS on the reverse graph to collect all transitive predecessors."""
    reverse = build_reverse_graph(graph)
    return get_all_descendants(task_id, reverse)


def successor_count(graph: dict[str, set[str]]) -> dict[str, int]:
    """Returns a dict mapping task_id → number of direct successors."""
    return {node: len(succs) for node, succs in graph.items()}


# ── Internal helpers ─────────────────────────────────────────────────────────

def _split_ids(raw: str) -> list[str]:
    return [s.strip() for s in raw.split(",") if s.strip()]


def _predecessors_of(node: str, graph: dict[str, set[str]]) -> list[str]:
    return [n for n, succs in graph.items() if node in succs]
