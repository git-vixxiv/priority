# Priority — AI-Driven Dependency-Aware Prioritization System

## What This Is

A personal priority management engine that solves "priority inflation" — the state where
everything feels equally urgent and nothing gets done. It uses WSJF (Weighted Shortest Job
First) combined with dependency graph analysis and Critical Path Method to produce an
algorithmically sequenced execution queue from seemingly competing, equally critical tasks.

## Core Algorithm: WSJF

```
WSJF Score = Cost of Delay / Job Size

Cost of Delay = Value_Score + Time_Criticality + RR_OE_Score
```

All component scores use the **Fibonacci scale only**: `1, 2, 3, 5, 8, 13, 20, 40, 100`

| Component | What It Measures |
|---|---|
| Value_Score | Direct economic or personal benefit of completing this task |
| Time_Criticality | How fast the value of this task decays if delayed |
| RR_OE_Score | Risk Reduction / Opportunity Enablement — does completing this unlock others? |
| Job_Size | Effort, complexity, and duration |
| Base_WSJF | (Value + Time_Criticality + RR_OE) / Job_Size — isolated score |
| Adjusted_WSJF | Base_WSJF + weighted rollup of all downstream successors (domino effect) |

**Key insight**: A small task with low Base_WSJF can have a very high Adjusted_WSJF if it
unblocks several high-value successors. That's the domino effect. Always act on Adjusted_WSJF.

## Architecture

```
User Input (CLI / Chrome Extension)
         ↓
  Claude Code (Orchestrator)
         ↓
  ┌──────────────────────────────────────┐
  │  Subagents                           │
  │  ├── decomposition-agent             │
  │  ├── evaluation-agent                │
  │  └── dependency-detective            │
  └──────────────────────────────────────┘
         ↓
  MCP → Google Sheets (State Machine)
         ↓
  Algorithms: WSJF + DAG + CPM + Bottleneck
```

## Required Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | Absolute path to your OAuth 2.0 credentials JSON file |
| `PRIORITY_SPREADSHEET_ID` | The Google Sheets ID (from the URL) |
| `PRIORITY_SHEET_TAB` | Sheet tab name (default: `Priorities`) |

## MCP Configuration

The `.claude/settings.json` file configures the Google Sheets MCP server. Before using:

1. Create a Google Cloud Project
2. Enable the Google Sheets API
3. Create OAuth 2.0 Desktop credentials
4. Download the credentials JSON
5. Set `GOOGLE_SHEETS_CREDENTIALS_PATH` to its path
6. Run `python scripts/setup_sheet.py` to initialize the spreadsheet schema
7. Copy the spreadsheet ID from the URL and set `PRIORITY_SPREADSHEET_ID`

## CLI Commands

```bash
# Add a new priority (triggers evaluation-agent for scoring)
python -m src.cli add "Description of priority"

# List all priorities ranked by Adjusted_WSJF
python -m src.cli list

# Run full re-sequencing analysis (reads sheet, recalculates everything)
python -m src.cli analyze

# Decompose a large task (Job_Size >= 13) into subtasks
python -m src.cli decompose T-101

# Scan for dependency issues and bottlenecks
python -m src.cli detect-bottlenecks

# Initialize or validate the Google Sheet schema
python -m src.cli setup-sheet

# Export current ranked queue as markdown report
python -m src.cli report
```

## Subagents

### decomposition-agent
- **Trigger**: Task has Job_Size >= 13 on the Fibonacci scale
- **Purpose**: Breaks large tasks into subtasks with estimated durations and WSJF scores
- **Output**: JSON array of subtask rows ready for sheet insertion

### evaluation-agent
- **Trigger**: New priority added without WSJF scores, or explicit evaluation request
- **Purpose**: Analyzes task description, generates structured pros/cons, recommends
  Fibonacci scores for all four WSJF components
- **Output**: JSON object with pros[], cons[], and recommended scores

### dependency-detective
- **Trigger**: Manual scan or any time a task is marked Completed
- **Purpose**: Traverses the dependency graph to find bottlenecks, unlinked tasks,
  circular dependencies, and critical path blockers
- **Output**: Structured analysis with severity ratings and resolution suggestions

## Scoring Rules

1. **Never score every task the same**. Use relative estimation — pick one task as a
   baseline (score 3 on each component) then score everything else relative to it.
2. **Fibonacci scale enforced**. Invalid scores are rejected.
3. **Job_Size >= 13** triggers mandatory decomposition before final scoring.
4. **Adjusted_WSJF** is the only field to use for sequencing decisions.
5. **Bottleneck score** = Frequency × Impact × Solvability (1–5 each). Tasks with
   bottleneck_score > 50 get priority inflation regardless of WSJF.

## Google Sheet Schema

See `src/sheets/schema.py` for the authoritative column definitions and validation rules.
Run `python -m src.cli setup-sheet` to create/validate the sheet structure.

## Status Values

| Status | Meaning |
|---|---|
| `Backlog` | Not started, waiting for sequencing |
| `In Progress` | Actively being worked |
| `Blocked` | Cannot proceed until a dependency completes |
| `Completed` | Done — triggers downstream recalculation |
| `Deferred` | Deliberately postponed, not in active queue |

## Development Notes

- Phase 1 is local/personal. No multi-tenancy, no auth layer beyond your own OAuth.
- All writes to Google Sheets go through MCP tools — never direct API calls from Claude.
- The DAG must remain acyclic. The dependency-detective catches cycles before any write.
- When in doubt, use `plan` permission mode to review proposed changes before execution.
