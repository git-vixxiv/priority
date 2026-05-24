"""Stakes parsing — financial magnitude and legal severity scoring."""

from __future__ import annotations
import re

_FINANCIAL_THRESHOLDS = [
    (1_000_000, 8.0),
    (100_000,   4.0),
    (10_000,    2.0),
]

_CRIMINAL_KEYWORDS = [
    'felony', 'criminal', 'arrest warrant', 'arrest', 'warrant',
    'indictment', 'prison', 'jail', 'contempt of court',
]
_HIGH_CIVIL_KEYWORDS = [
    'injunction', 'judgment', 'contempt', 'sanctions',
    'protective order', 'restraining order',
]
_STANDARD_CIVIL_KEYWORDS = [
    'lawsuit', 'litigation', 'plaintiff', 'defendant',
    'statute of limitations', 'bar complaint', 'appeal',
]

STOP_WORDS = {
    'the', 'a', 'an', 'on', 'in', 'to', 'of', 'for', 'and', 'or', 'but',
    'with', 'by', 'at', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these',
    'those', 'it', 'its', 'my', 'our', 'your', 'their', 'his', 'her',
    'against', 'after', 'before', 'during', 'about', 'into', 'through',
    'between', 'because', 'while', 'not', 'no', 'as', 'if', 'up', 'out',
    'file', 'motion', 'complaint', 'also', 'then', 'than', 'its', 'all',
    'they', 'their', 'we', 'us', 'him', 'her', 'me', 'who', 'which',
}


def parse_stakes_adjustment(stakes_text: str, category: str = "") -> float:
    """
    Parse stakes description and return additive adjustment to Adjusted_WSJF.

    Financial scale (largest dollar amount found in text):
      $1M+    → +8.0
      $100K+  → +4.0
      $10K+   → +2.0
      < $10K  → 0.0

    Legal severity (keyword scan):
      Criminal / felony / arrest warrant → +8.0
      High civil (injunction, judgment)  → +4.0
      Standard civil / bar complaint     → +2.0
      Minor / administrative             → 0.0

    Returns the higher of the two bonuses.
    """
    if not stakes_text:
        return 0.0
    return max(_financial_bonus(stakes_text), _legal_bonus(stakes_text))


def _parse_financial_amount(text: str) -> float | None:
    amounts: list[float] = []

    for m in re.finditer(r'\$\s*([\d,]+(?:\.\d+)?)\s*[Bb](?:illion)?', text, re.I):
        amounts.append(float(m.group(1).replace(',', '')) * 1e9)

    for m in re.finditer(r'\$\s*([\d,]+(?:\.\d+)?)\s*[Mm](?:illion)?', text, re.I):
        amounts.append(float(m.group(1).replace(',', '')) * 1e6)

    for m in re.finditer(r'\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]', text, re.I):
        amounts.append(float(m.group(1).replace(',', '')) * 1e3)

    for m in re.finditer(r'\$\s*([\d,]+(?:\.\d+)?)', text, re.I):
        amounts.append(float(m.group(1).replace(',', '')))

    return max(amounts) if amounts else None


def _financial_bonus(text: str) -> float:
    amount = _parse_financial_amount(text)
    if amount is None:
        return 0.0
    for threshold, bonus in _FINANCIAL_THRESHOLDS:
        if amount >= threshold:
            return bonus
    return 0.0


def _legal_bonus(text: str) -> float:
    lower = text.lower()
    if any(kw in lower for kw in _CRIMINAL_KEYWORDS):
        return 8.0
    if any(kw in lower for kw in _HIGH_CIVIL_KEYWORDS):
        return 4.0
    if any(kw in lower for kw in _STANDARD_CIVIL_KEYWORDS):
        return 2.0
    return 0.0


def _stem(word: str) -> str:
    for suffix in ('ing', 'tion', 'ions', 'ed', 'es', 'er', 'est', 'ly', 's'):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[:-len(suffix)]
    return word


def _meaningful_stems(text: str) -> set[str]:
    words = re.findall(r'\b[a-z]{3,}\b', text.lower())
    return {_stem(w) for w in words if w not in STOP_WORDS}


def resolve_dependency_hints(
    tasks: list[dict],
) -> dict[str, list[str]]:
    """
    For each task with Dependency_Hints text, find the best matching task IDs
    by word-stem overlap against all task names.

    Returns {task_id: [matched_task_id, ...]} for confident matches.
    Only suggests tasks not already in Predecessor_IDs.
    A confident match requires >= 2 shared meaningful stems, or >= 1 stem
    matching >= 40% of the hint's stems.
    """
    if not tasks:
        return {}

    name_stems: dict[str, set[str]] = {
        t['Task_ID']: _meaningful_stems(t.get('Task_Name', ''))
        for t in tasks if t.get('Task_ID')
    }

    results: dict[str, list[str]] = {}

    for task in tasks:
        tid = task.get('Task_ID')
        hints = (task.get('Dependency_Hints') or '').strip()
        if not tid or not hints:
            continue

        existing = {
            p.strip()
            for p in (task.get('Predecessor_IDs') or '').split(',')
            if p.strip()
        }

        hint_stems = _meaningful_stems(hints)
        if not hint_stems:
            continue

        matches: list[tuple[str, int]] = []
        for other_tid, other_stems in name_stems.items():
            if other_tid == tid or other_tid in existing:
                continue
            overlap = hint_stems & other_stems
            if len(overlap) >= 2 or (
                len(overlap) >= 1 and len(overlap) / len(hint_stems) >= 0.4
            ):
                matches.append((other_tid, len(overlap)))

        if matches:
            matches.sort(key=lambda x: -x[1])
            results[tid] = [matches[0][0]]

    return results
