# {{PROJECT_NAME}} - Development Log

**Status:** In Development
**Tech Stack:** {{TECH_STACK}}
**CLI:** `node tasks/cli.js` | **DB:** `tasks/tasks.db`

---

<!-- agentic-workflow:start — managed by agentic-workflow-template; this block is replaced on upgrade, edit outside it -->
## Agentic Workflow

Work is tracked in the task DB and carried out by the project subagents in `.claude/agents/`: `developer`, `reviewer`, `researcher`, `decomposer`.

### Orchestrator rules (main session only — subagents ignore this section)
- Run task-DB tasks through `/work-task`. It claims the task, runs the `task-pipeline` workflow and records the outcome. Only hand-run the loop from `.claude/ORCHESTRATION.md` when the Workflow tool is unavailable.
- Spawn project agents by name (`subagent_type: "developer"`, `"reviewer"`, …), never as `general-purpose` told to read an agent file.
- Never complete a task whose review failed. A task blocked after 3 fix rounds goes back to the user; don't keep looping.
- Direct edits by the main session are fine for trivial work: `/work-task`'s haiku/no-review fast path, or small changes the user asks for that aren't in the task DB.

### Commands
| Say / type | What happens |
|---|---|
| `/work-task 7` or "work on task 7" | preflight → claim → develop → review → fix rounds → complete/block |
| `/work-task 7 8 9` | parallel; tasks that share files run one after another |
| `/work-task next` | highest-priority ready task |
| `/decompose <goal or spec path>` | decomposer proposes tasks; created after you approve |
| `/dry-run 7` | routing + preflight, nothing claimed or spawned |
| `/wrap-up` or "done" | handoff summary in `.claude/handoffs/` |

### Task CLI
```bash
node tasks/cli.js list --status ready     # also: next, stats, get <id>, brief
node tasks/cli.js add --title "..." --priority HIGH --description "..." [--files "a.ts,b.ts"] [--blocked-by "3"]
node tasks/cli.js route <id>              # model/effort/reviews a claim would get
node tasks/cli.js artifact get <id> --type review_report
node tasks/cli.js context-digest          # after editing .claude/context/*
```

### Model routing (inferred at claim; pin with `--model` / `--effort` on add or update)
| Task | Developer |
|---|---|
| CRITICAL | opus / xhigh |
| 5+ files | opus / high |
| ≤1 file, short spec | haiku (no review) |
| HIGH or 3-4 files | sonnet / high |
| everything else | sonnet / medium |

Reviews run on opus/high; fix verification runs on sonnet/high. Fix rounds keep the task's tier, and the 3rd round escalates one tier. Fable is never picked automatically — pin `--model fable` on a task that keeps getting blocked.
<!-- agentic-workflow:end -->

---

## Key Decisions

Record major architectural decisions here as they are made.

| Date | Decision | Rationale |
|------|----------|-----------|
| | {{TECH_STACK}} | [Fill in rationale] |

---

## Development Notes

<!-- Add project-specific notes, conventions, and quick-reference info below -->
