# Orchestration Reference

**Project:** {{PROJECT_NAME}} | **Task CLI:** `node tasks/cli.js`

The normal path is **`/work-task <id>`**: it claims the task, runs the saved `task-pipeline` workflow (`.claude/workflows/task-pipeline.js`), and records the outcome. This file is the **manual fallback** for when the Workflow tool is unavailable. It describes the same loop step by step, so the two stay equivalent.

---

## The Loop

```
preflight → claim (routing) → developer → reviewer ─┬─ PASS / PASS_WITH_WARNINGS → complete (+ follow-ups)
                                                    └─ FAIL → fix developer → scoped verify ─┐
                                                        ↑  (max 3 rounds; round 3 escalates)  │
                                                        └──────────────── FAIL ◄──────────────┘
                                                                  still FAIL after round 3 → block
```

### 1. Preflight and claim
```bash
node tasks/cli.js preflight <id>                      # stop on ✗ problems
node tasks/cli.js claim <id> --agent developer --json # routing: model, effort, reviews, context_files
```

### 2. Developer
Spawn the project agent by name. Its tools and defaults come from `.claude/agents/developer.md`:
```
Agent(
  subagent_type: "developer",
  model: <model from claim>,           # omit effort if claim says "default"
  description: "Developer - Task <id>: <title>",
  prompt: "Task ID: <id> | Iteration: 1
           Title / Priority / Description / Files affected / Context files: <from claim JSON>
           Implement, run tests, save the dev_report artifact with --iteration 1, and return your report."
)
```
The developer saves its own `dev_report` artifact. If it reports `ISSUES` that block progress, treat that as a failure and block the task.

### 3. Review (skip if `reviews` is `none`)
```
Agent(
  subagent_type: "reviewer",           # opus/high from its frontmatter, read-only
  description: "Reviewer - Task <id>: <title>",
  prompt: "Task ID: <id> | Iteration: 1
           REVIEW DIMENSIONS: <reviews from claim>
           Retrieve the dev report, review, save the review_report artifact with --iteration 1, return your review."
)
```

### 4. Fix rounds (on FAIL, max 3)
For round N (iteration N+1):
- **Fix developer:** same as step 2, with `FIX ROUND N of 3` and the reviewer's Must Fix list in the prompt, `--iteration N+1`. In round 3, escalate one tier: haiku → sonnet/high, sonnet → opus/high, opus → opus/xhigh.
- **Scoped verify:** reviewer with `model: "sonnet"` and prompt starting `REVIEW MODE: SCOPED FIX VERIFICATION`, listing the ORIGINAL ISSUES.
- Still FAIL after round 3 → `node tasks/cli.js block <id> --reason "Failed review after 3 fix rounds: <issues>"` and tell the user. Don't start a 4th round.

### 5. Record the outcome
| Result | Command |
|---|---|
| PASS | `node tasks/cli.js complete <id> --summary "..."` |
| PASS_WITH_WARNINGS | complete, then `node tasks/cli.js add --title "Follow-up: ..." --priority LOW --parent-task <id> --description "..."` per worthwhile warning |
| Blocked / failed | `node tasks/cli.js block <id> --reason "..."` |

---

## Parallel Tasks

Tasks whose `files_affected` overlap, or that list no files, run **sequentially**. Everything else runs in parallel. With the Agent tool that means one message containing all developer calls for a step, then one message containing all reviewer calls. Label every call with its task ID. `node tasks/cli.js conflict-check 7,8,9` shows overlaps.

## Error Recovery

| Failure | Recovery |
|---|---|
| Subagent returns empty/garbage | Re-spawn once with the same parameters; still bad → block the task |
| Reviewer output unparseable | Re-spawn once; still bad → PASS_WITH_WARNINGS + follow-up "Manual review needed" |
| CLI command fails | Report the error to the user; don't advance |
| `Task DB is locked` | Another CLI process is mid-write; retry. If none is running, delete `tasks/tasks.db.lock` |

## Subagent Roster

| Agent | Default model | Used by |
|---|---|---|
| `developer` | sonnet / medium (claim routing overrides) | develop + fix rounds |
| `reviewer` | opus / high, read-only, project memory | review; sonnet for scoped verify |
| `researcher` | sonnet / medium, read-only | on demand, for web/doc research |
| `decomposer` | opus / high, read-only | `/decompose` |

For codebase-only questions, use the built-in `Explore` agent rather than `researcher`.
