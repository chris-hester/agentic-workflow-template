# Orchestration Guide

**Project:** {{PROJECT_NAME}}
**Task CLI:** `node tasks/cli.js`

---

## Workflow: "Work on Task X"

### Step 1 — Get task details
```bash
node tasks/cli.js get <id>
```

### Step 2 — Claim and read inference
```bash
node tasks/cli.js claim <id> --agent developer
```

The CLI auto-infers and outputs model, reviews, and context files. Read the output:
```
✅ Task #5 claimed by developer
   Model: sonnet
   Reviews: qa,security
   Context: requirements-summary.md, design-system.md
```

Use these values for all subagent spawning in subsequent steps. If the task already has explicit model/reviews in the DB, those override inference.

### Step 2.5 — Pre-flight check

Before spawning a developer, verify basics:
```bash
# Check listed files exist (if files_affected populated)
for file in [files_affected split by comma]; do
  [ -f "$file" ] || echo "⚠️ Missing: $file"
done

# Check test runner
npx {{TESTING}} --version 2>/dev/null || echo "⚠️ Test runner not available"
```

If critical files are missing, notify the user before spawning. The orchestrator may resolve path issues (it can run bash) or ask the user.

### Step 3 — Spawn developer subagent

```
Task(
  description: "Developer - Task [id]: [title]",
  subagent_type: "general-purpose",
  model: [model from claim output],
  prompt: "Read .claude/agents/developer.md and follow its instructions exactly.
           Task ID: [id] | Title: [title]
           Description: [full description]
           Files Affected: [files_affected]
           Context files to load: [from claim output]
           Implement and return your structured report."
)
```

**After developer returns**, save the report as an artifact:
```bash
node tasks/cli.js artifact save [id] --type dev_report --content "[developer's full structured response]" --agent developer
```

### Step 4 — Review (conditional)

Check `reviews` value from the claim output.

**If reviews = `none`:** Skip to Step 5.

**Scoped fix review** (fix tasks from Step 6 loop):
```
Task(
  description: "Reviewer - Task [id]: Verify fix",
  subagent_type: "general-purpose",
  model: [model from claim output],
  prompt: "Read .claude/agents/reviewer.md.
           REVIEW MODE: SCOPED FIX VERIFICATION
           Task ID: [id]
           ORIGINAL ISSUE: [the specific issue from failed review]
           Retrieve dev report: node tasks/cli.js artifact get [id] --type dev_report
           ONLY verify the specific issue was fixed. Return PASS or FAIL."
)
```

**Standard review:**
```
Task(
  description: "Reviewer - Task [id]: [title]",
  subagent_type: "general-purpose",
  model: [model from claim output],
  prompt: "Read .claude/agents/reviewer.md.
           Task ID: [id]
           REVIEW DIMENSIONS: [reviews from claim output]
           Retrieve dev report: node tasks/cli.js artifact get [id] --type dev_report
           Return your Consolidated Review Report."
)
```

**After reviewer returns**, save the report:
```bash
node tasks/cli.js artifact save [id] --type review_report --content "[reviewer's report]" --agent reviewer
```

### Step 5 — Evaluate and complete

**If reviews was `none`:**
```bash
node tasks/cli.js complete <id> --summary "[brief summary from developer report]"
```

**If reviews were run**, apply the decision matrix:

| Signal in Report | Classification |
|-----------------|----------------|
| "CRITICAL", "FAIL", "Must Fix" | **FAIL** |
| "PASS WITH WARNINGS", "Should Fix" | **WARNINGS** |
| "PASS", "SECURE", "MEETS REQUIREMENTS" | **PASS** |

| Outcome | Action |
|---------|--------|
| Any FAIL | Create fix tasks: `node tasks/cli.js add --title "Fix: [issue]" --priority HIGH --description "[details]" --category Development --parent-task [id] --iteration [N]` |
| All PASS | Complete: `node tasks/cli.js complete <id> --summary "[summary]"` |
| PASS + WARNINGS | Complete + create follow-ups: `node tasks/cli.js add --title "Follow-up: [warning]" --priority LOW ...` |

### Step 6 — Loop if needed

| Outcome | Action |
|---------|--------|
| **FAIL** | Fix tasks created in Step 5. For EACH: claim → developer → scoped review → evaluate. |
| **PASS** | Report completion. Run `node tasks/cli.js next` to suggest next task. |
| **PASS_WITH_WARNINGS** | Report completion. Mention follow-ups. Suggest next task. |

### Fix Loop Circuit Breaker (max 3 iterations)

| Iteration | Action |
|-----------|--------|
| 1-2 | Normal: fix developer → scoped review → evaluate |
| 3 | Final attempt. If review still FAILs: |
| | → `node tasks/cli.js block [id] --reason "Failed review 3x: [summary]"` |
| | → Report to user: "Task blocked after 3 fix attempts. Consider splitting or redefining." |
| | → Do NOT create another fix task. |

Before spawning a fix developer, check the task's iteration value. If iteration >= 3 AND review FAIL → block.

---

## Parallel Task Execution

When user requests multiple tasks (e.g., "work on task 7 and 8"):

```
Step 1-2:  Get + Claim task 7  |  Get + Claim task 8        (parallel Bash calls)
Step 3:    Developer - Task 7  |  Developer - Task 8        (parallel Task calls, ONE message)
Step 4:    Reviewer - Task 7   |  Reviewer - Task 8         (parallel Task calls, ONE message)
Step 5:    Evaluate both (orchestrator, no subagent needed)
Step 6:    Handle independently: PASS tasks done, FAIL tasks loop
```

**Rules:**
1. Same step across all tasks → single message with parallel tool calls
2. Wait for ALL tasks to complete a step before advancing any
3. Loop independently on failures
4. Label with task ID: `"Developer - Task 7: Build hero section"`

---

## Error Recovery

| Failure | Recovery |
|---------|----------|
| Subagent returns empty/garbage | Re-spawn once with same parameters. If second attempt fails, block task. |
| Subagent timeout | Block task: "Subagent timeout — consider splitting task." |
| Developer reports ISSUES ≠ "none" | Evaluate severity. Blocking → treat as FAIL. Informational → proceed to review. |
| Reviewer report unparseable | Re-spawn once. If still unparseable → PASS_WITH_WARNINGS + follow-up: "Manual review needed." |
| CLI command fails | Report error to user. Do not proceed to next step. |

---

## Subagent Roster

All use `subagent_type: "general-purpose"` and read their `.md` file.

| Agent | File | When |
|-------|------|------|
| developer | `developer.md` | Step 3 |
| reviewer | `reviewer.md` | Step 4 (covers QA + security + scope in one pass) |
| researcher | `researcher.md` | On demand |
| decomposer | `decomposer.md` | On "decompose [goal]" |

---

## Dry Run Mode

When user says **"dry run task X"**:

1. Run Steps 1-2 (get, claim — reads inference output)
2. Run pre-flight checks (Step 2.5)
3. **STOP. Do not spawn subagents.**

Report:
```
Dry Run — Task #[id]: [title]
  Model: [from claim]
  Reviews: [from claim]
  Context: [from claim]
  Files: [from task]
  Pre-flight: [✅ or ⚠️]
  Subagent calls: [N developer + N reviewer]
```

Release claimed tasks after: `node tasks/cli.js release [id]`

---

## Session Summary

When user says **"done"**, **"wrap up"**, or all queued tasks complete:

```markdown
# Session Summary — [date]

## Completed
- Task #[id]: [title] ([PASS|PASS_WITH_WARNINGS], [N] review cycles)

## Blocked
- Task #[id]: [title] (reason)

## Still In Progress
- Task #[id]: [title] (status)

## Auto-Unblocked This Session
- Task #[id] (was blocked by #[id])

## Next Session Suggestion
- Task #[id] ([priority]) — [why this is next]
```

Save to: `.claude/handoffs/session-[YYYY-MM-DD].md`
