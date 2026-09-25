---
name: work-task
description: Run the full loop for one or more task-DB tasks — preflight, claim, develop, review, fix rounds, then record the outcome. Use when the user says "work on task 7", "work on tasks 7 and 8", or "work on the next task".
argument-hint: "<id> [id ...] | next"
---

# Work on tasks: $ARGUMENTS

## 1. Resolve task IDs
- IDs given → use them.
- `next` (or no argument) → `node tasks/cli.js next` and take that task's ID. None ready → say so and stop.

## 2. Preflight (one Bash call per task, in parallel)
```bash
node tasks/cli.js preflight <id>
```
Drop any task with ✗ problems (already done, blocked, open dependencies) and tell the user why. ⚠ notes are informational.

## 3. Claim (parallel)
```bash
node tasks/cli.js claim <id> --agent developer --json
```
Each call prints a JSON payload: id, title, description, files_affected, model, effort, reviews, context_files, iteration. Keep them exactly as printed.

**Trivial fast path:** a task routed `haiku` with `reviews: "none"` is a small, low-risk change (one file, short spec). You may implement it directly instead of spawning agents: make the edit, run the tests, then complete it in step 5.

## 4. Run the pipeline
Launch the saved workflow with all remaining payloads in one call:

```
Workflow({ name: "task-pipeline", args: { tasks: [<payload>, <payload>, ...] } })
```

`args.tasks` must be a real JSON array of the payload objects, not a string. The workflow runs in the background: wait for its completion notification, don't poll it.

It develops each task (developer agent at the claimed model/effort), reviews it (reviewer agent), and runs up to 3 fix rounds with scoped verification. The last round escalates one model tier. Tasks that share files run one after another; the others run in parallel. It returns `{ results: [...] }`, one entry per task with `outcome`, `summary`, `files_modified`, `warnings`, `critical`, `fix_rounds`.

**If the Workflow tool is unavailable** (disabled in settings, or not on this plan), run the same loop by hand following `.claude/ORCHESTRATION.md`.

## 5. Record outcomes
| outcome | Do |
|---|---|
| `PASS` | `node tasks/cli.js complete <id> --summary "<summary>"` |
| `PASS_WITH_WARNINGS` | Complete as above, then one follow-up per distinct, worthwhile warning (merge duplicates, skip nits): `node tasks/cli.js add --title "Follow-up: <warning>" --priority LOW --parent-task <id> --description "<detail + file:line>"` |
| `FAILED_REVIEW` | `node tasks/cli.js block <id> --reason "Failed review after <fix_rounds> fix rounds: <critical issues, short>"` |
| `DEV_BLOCKED` | `node tasks/cli.js block <id> --reason "<developer's summary/issues>"` |
| `ERROR` | `node tasks/cli.js block <id> --reason "Subagent failure — consider splitting the task"` |

`complete` prints any tasks it auto-unblocked, so pass those along.

## 6. Report
One line per task: `#id title — outcome (N fix rounds, model)`, plus follow-ups created, tasks unblocked, and anything blocked with its reason. Suggest a model pin for a task that keeps failing: `node tasks/cli.js update <id> --model opus --effort xhigh` (or `--model fable`). Finish with `node tasks/cli.js next`.
