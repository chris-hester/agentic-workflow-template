# Agentic Workflow Template for Claude Code

A scaffold that sets up an orchestrated agentic coding workflow for Claude Code. Instead of Claude doing everything in a single context, this system splits work across specialized subagents, tracks all work in a SQLite task database, automates code review, and loops until quality gates pass. It installs into a new project or on top of an existing codebase.

---

## What This Is

This template sets up a workflow that:

- **Splits work across project subagents**: `developer`, `reviewer`, `researcher`, `decomposer`. They're real Claude Code agent types, each with its own model, effort, and tool limits.
- **Runs the task loop as a deterministic workflow.** The `task-pipeline` workflow script does develop → review → up to 3 fix rounds, so the main session can't drift from the process.
- **Tracks all work in a SQLite task database**, with a CLI for tasks, dependencies, artifacts and multi-session work.
- **Routes model *and* effort per task.** Haiku for trivial edits, Sonnet for standard work, Opus for big or critical tasks. Reviews always run on Opus. Fix rounds never drop below the task's tier, and the last one escalates.
- **Automates code review.** One read-only reviewer covers QA, security and scope, and remembers recurring issues across tasks.
- **Runs deterministic checks via hooks.** eslint on every edit and `npm audit` on dependency changes, fed back to Claude when something's wrong.
- **Runs tasks in parallel safely.** Tasks that touch the same files run one after another, the rest in parallel, and the task DB is lock-protected.
- **Installs over existing projects.** Your CLAUDE.md, settings and MCP servers are merged, not replaced, and every changed file is backed up.

Instead of asking Claude to "just build X," you:
1. `/decompose` a goal into tasks (or add them with the CLI)
2. `/work-task next`
3. The workflow spawns a developer agent at the task's routed model and effort
4. A reviewer agent reviews it (QA + security + scope in one pass)
5. On FAIL, fix rounds run with scoped re-verification, up to 3; the last round escalates a model tier
6. The outcome is recorded: completed, completed with follow-ups, or blocked with a reason

---

## How It Works

### The Loop

`/work-task 7` (or just "work on task 7") runs:

| Step | Who | What |
|------|-----|------|
| **1. PREFLIGHT** | Main session | `node tasks/cli.js preflight 7` — already done? blocked? open dependencies? |
| **2. CLAIM** | Main session | `node tasks/cli.js claim 7 --json` — routes model, effort, review dimensions, context files |
| **3. DEVELOP** | `developer` agent | Implements, runs tests, saves a `dev_report` artifact |
| **4. REVIEW** | `reviewer` agent | Reads the diff + report, reviews the assigned dimensions, returns PASS / PASS_WITH_WARNINGS / FAIL |
| **5. FIX** | `developer` + `reviewer` | On FAIL: fix exactly the Must Fix items, scoped re-verification, max 3 rounds, round 3 escalates |
| **6. RECORD** | Main session | complete / complete + follow-up tasks / block with reason; auto-unblocks dependents |

Steps 3-5 are `.claude/workflows/task-pipeline.js`, a saved Claude Code workflow. Its control flow is code, not prose instructions. `.claude/ORCHESTRATION.md` describes the same loop for running it by hand with the Agent tool when workflows aren't available.

**Key principles:**
- Project agents are spawned **by name** (`subagent_type: "developer"`), so their frontmatter model, effort and tool limits actually apply. The reviewer genuinely can't edit files.
- Subagents pass reports through the task DB (**artifacts**), not through the main session's context.
- Task status changes happen in one place: the main session, after the workflow returns.
- The main session may make trivial edits itself (haiku-routed, no-review tasks); everything else goes through the loop.

---

## Quick Start

### 1. Install into your project

From your project's root (new or existing):

```bash
node /path/to/agentic-workflow-template/bootstrap.js --dry-run   # preview: what gets created / merged / backed up
node /path/to/agentic-workflow-template/bootstrap.js
```

The installer:
- Asks 10 questions, pre-filled from your `package.json` (name, framework, styling, test runner). Pass `--yes` to accept the detected answers.
- Writes the agents, skills, workflow, hooks and task CLI.
- **Merges** instead of overwriting when files already exist (see [Installing over an existing project](#installing-over-an-existing-project)).
- Installs the task CLI's one dependency (`sql.js`), initializes the DB, and generates the context digest.
- Records your answers in `.claude/agentic-workflow.json` so upgrades never re-ask.

Options: `--target <dir>`, `--dry-run`, `--yes`, `--upgrade`, `--skip-deps`, `--help`.

### 2. Fill in context files

- `.claude/context/project-overview.md` — goals, users, success criteria
- `.claude/context/design-system.md` — colors, typography, spacing, components
- `.claude/context/requirements-summary.md` — features, acceptance criteria, code standards

Then run `node tasks/cli.js context-digest`. Subagents read the compact `DIGEST.md` first.

### 3. Create tasks

```
/decompose Build a marketing site with home, pricing, blog, and contact.
```

Or directly:

```bash
node tasks/cli.js add --title "Build landing page hero" --priority HIGH \
  --description "Headline, CTA button, background image. Done when it matches design-system.md at all breakpoints." \
  --category Development --files "src/components/Hero.tsx,src/pages/index.tsx"
```

### 4. Start working

```
/work-task next
```

---

## Installing Over an Existing Project

Re-running `bootstrap.js` on a project that already has the workflow **upgrades** it; it detects `.claude/agentic-workflow.json` or a pre-V6 layout. On a project without the workflow, it **installs** without clobbering anything:

| File | What happens |
|---|---|
| `CLAUDE.md` | Only the `<!-- agentic-workflow:start/end -->` block is ours. Your own CLAUDE.md is kept and the block is appended. On upgrades only the block is replaced. Pre-V6 template CLAUDE.md files have their old Role / Forbidden Actions / CLI / Workflow sections swapped for the block; Key Decisions and Development Notes are kept. |
| `.claude/settings.json` | Merged: your keys, permissions and hooks are kept, the template's are added. Broken V5 hooks and the V5 `ENABLE_TOOL_SEARCH` flag are removed, and old `Bash(x:*)` rules are deduped against their `Bash(x *)` equivalents. |
| `.mcp.json` | An existing file is left alone (it's often gated by `enabledMcpjsonServers`); the installer just lists template servers you don't have. Created from the template only when absent. |
| `.gitignore` | Missing entries are appended. |
| `.claude/context/*`, `settings.local.json` | Created only if absent. |
| Agents, skills, workflow, hooks, `tasks/*.js` | Template-owned: updated in place, previous version backed up if it differed. |
| `tasks/tasks.db` | Never replaced. Its schema migrates itself on first use (additive only). |

Every file that gets changed is backed up under `.claude/backups/<timestamp>/` (gitignored). Re-running with no template changes is a no-op. Restart Claude Code in the project afterwards so it loads the new agents, skills and hooks.

If your project already has its own `.claude/agents/developer.md` (or `reviewer.md`, etc.), it will be replaced and the original backed up. Rename yours first if you want both. Other custom agents (say, a `ui-ux.md`) are never touched, and the installer tells you how to wire them into reviews (below).

---

## Common Prompts

### Decomposing a goal into tasks

```
/decompose Build a marketing site with home, pricing, blog, and contact.
           Phases: 1=design system, 2=static pages, 3=blog,
           4=forms, 5=polish + a11y + perf.

/decompose .claude/context/spec.md
```

The decomposer (Opus, read-only) proposes tasks with priorities, groups and dependencies. **Nothing is created until you approve.** Dependencies between new tasks are wired afterwards, and dependent tasks stay `blocked` until they auto-unblock.

### Working tasks

```
/work-task 7                      # full loop for one task
/work-task 7 8 9                  # parallel; tasks sharing files run sequentially
/work-task next                   # highest-priority ready task
work on task 7                    # same as /work-task 7
```

### Inspecting and steering

```
/dry-run 12                       # routing + preflight, nothing claimed or spawned
show me ready tasks in group B
what did the reviewer say about task 7?     # → artifact get 7 --type review_report
block task 15 — waiting on design feedback
release task 7                    # return a claimed task to the pool
pin task 9 to opus                # → update 9 --model opus
```

### Heavier reviews (manual triggers)

```
/security-review                  # built-in deep security audit
/code-review ultra                # cloud multi-agent review, at phase boundaries
```

### Using the MCPs

chrome-devtools and shadcn load on demand through tool search, so they cost nothing until used:

```
Use the chrome-devtools MCP to screenshot the pricing page on mobile and tell me what looks broken.
Use the shadcn MCP to scaffold a Card component with header, content, and footer slots.
```

### End of session

```
/wrap-up                          # or "done"
```

Writes `.claude/handoffs/session-YYYY-MM-DD.md`: completed, blocked, still in progress, next up. It offers to release tasks left `in_progress`. At the next session start, a hook prints a one-paragraph task DB status into Claude's context.

---

## What Gets Created

```
your-project/
├── .claude/
│   ├── agents/                   # developer, reviewer, researcher, decomposer
│   ├── skills/                   # /work-task, /decompose, /dry-run, /wrap-up
│   ├── workflows/
│   │   └── task-pipeline.js      # develop → review → fix-loop, as code
│   ├── hooks/
│   │   ├── post-edit.cjs         # eslint --fix + npm audit, results fed back to Claude
│   │   └── session-start.cjs     # task DB status into context
│   ├── context/                  # project-overview, design-system, requirements-summary (+ DIGEST.md)
│   ├── ORCHESTRATION.md          # manual fallback for the loop
│   ├── settings.json             # permissions + hooks
│   ├── agentic-workflow.json     # installed version + your answers (commit this)
│   ├── handoffs/                 # session summaries (gitignored)
│   └── backups/                  # install/upgrade backups (gitignored)
├── .mcp.json                     # chrome-devtools, shadcn (pinned)
├── tasks/
│   ├── cli.js, db.js, package.json
│   └── tasks.db                  # auto-created, gitignored
└── CLAUDE.md                     # your notes + the managed workflow block
```

---

## Agents

| Agent | Default model | Tools | Role |
|-------|---------------|-------|------|
| `developer` | sonnet / medium; the claim's routing overrides it per task | all | Implements one task, runs tests, saves a `dev_report` artifact |
| `reviewer` | opus / high | read-only, `memory: project` | QA + security + scope in one pass, or scoped fix verification (on sonnet) |
| `decomposer` | opus / high | read-only | Goal → task plan + CLI commands |
| `researcher` | sonnet / medium | read-only | Web/doc research with sources. For codebase-only questions use the built-in `Explore` agent. |

### Extra reviewers

To run a project-specific agent alongside `reviewer` (a visual/UI auditor, a domain expert), add it to `.claude/agentic-workflow.json`:

```json
"extraReviewers": [{ "agent": "ui-ux", "when": "pm" }]
```

`when` is a review dimension (`qa`, `security`, `pm`) or `always`. On matching tasks it runs in parallel with the main reviewer, told to review only (`FIX_MODE: false`) and to save a `<agent>_report` artifact. The worst status wins, and its Must Fix items go into the fix round tagged `[ui-ux]`. Fix verification is done by the main reviewer. `route <id>` shows which extra reviewers a task would get. The setting survives upgrades.

Edit the frontmatter (`model`, `effort`, `disallowedTools`) to change defaults; upgrades back up your version before replacing it. The reviewer uses project-scoped memory, so what it learns is shared by everyone working on the repo.

---

## Model Routing

`claim` (and `route`, which doesn't claim) infers the developer's model and effort:

| Task | Model / effort | Review |
|------|----------------|--------|
| Priority CRITICAL | opus / xhigh | always |
| 5+ files | opus / high | yes |
| ≤1 file and a short description | haiku | none (main session may do it directly) |
| Priority HIGH, or 3-4 files | sonnet / high | yes |
| Everything else | sonnet / medium | yes |

- **Fix rounds** keep the task's tier. The **3rd round escalates**: haiku → sonnet/high, sonnet → opus/high, opus → opus/xhigh. (V5 sent every `Fix:` task to Haiku, i.e. the weakest model for the tasks that had just failed.)
- **Reviews** run on the reviewer's opus/high; **scoped fix verification** on sonnet/high.
- **Fable** is never chosen automatically. For a task that keeps getting blocked: `node tasks/cli.js update <id> --model fable`.
- **Pin** anything with `--model` / `--effort` on `add` or `update`. Pinned routing always wins. A model pinned without an effort still gets the effort its priority/size implies (pinned opus on a CRITICAL task runs at xhigh).

**Review dimensions:** `qa` always; `security` when the task mentions a security keyword (API, auth, env, form, token…, plus your CMS); `pm` for user-facing work (page, component, layout, UX…) that isn't a fix.

---

## Task CLI

```bash
# Tasks
node tasks/cli.js list [--status ready] [--priority HIGH] [--group B]
node tasks/cli.js get 7
node tasks/cli.js add --title "..." --priority HIGH --description "..." --files "a.ts,b.ts" [--blocked-by "3,4"] [--model opus] [--effort high]
node tasks/cli.js update 7 --priority CRITICAL [--model fable] [--blocked-by "9"]
node tasks/cli.js claim 7 --agent developer [--json]
node tasks/cli.js route 7 [--json]          # routing without claiming
node tasks/cli.js preflight 7 [--json]      # status, open deps, missing files
node tasks/cli.js complete 7 --summary "..."   # prints auto-unblocked dependents
node tasks/cli.js block 7 --reason "..." | unblock 7 | release 7

# Status
node tasks/cli.js stats | next | brief | stale [--hours 24] | history 7
node tasks/cli.js dependency-tree 7 | dependency-graph

# Artifacts (reports passed between agents)
node tasks/cli.js artifact save 7 --type dev_report --iteration 1 --stdin <<'REPORT'
...
REPORT
node tasks/cli.js artifact get 7 --type review_report [--iteration 2]
node tasks/cli.js artifact list 7

# Multi-session (separate Claude Code windows)
node tasks/cli.js suggest-batch --sessions 3 [--assign]
node tasks/cli.js session-tasks session-1 | conflict-check 7,8,9

# Utilities
node tasks/cli.js context-digest | export --format md --file tasks.md
```

`--blocked-by` on a new task sets it to `blocked`; it becomes `ready` automatically when its last dependency completes. The DB takes a lock file for each CLI call, so parallel agents can't overwrite each other's writes. If a crashed process leaves `tasks/tasks.db.lock` behind, it's cleared after 30 seconds.

---

## Parallel Tasks

```
/work-task 5 6 7
```

The workflow groups tasks into **lanes**. Tasks whose `files_affected` overlap, or that list no files, run sequentially in one lane; lanes run in parallel. Reviewers diff only their task's files, so independent lanes don't see each other's changes. `/dry-run 5 6 7` shows the lanes before you commit to a run.

For larger batches across several Claude Code windows, use `suggest-batch --sessions N --assign`. Never run two windows on the same task.

---

## MCP Servers, Hooks & Permissions

### MCPs (`.mcp.json`)

| MCP | Purpose |
|-----|---------|
| `chrome-devtools-mcp@1.10.1` (Google) | Real Chrome: screenshots, console, network, performance traces |
| `shadcn@4.21.0 mcp` | Live shadcn component source (stops prop hallucination) |

Versions are pinned and chrome-devtools telemetry is off. Playwright was dropped from the default set because it overlaps chrome-devtools for the same browser target. Add it when you need cross-browser or auth-flow tests: `claude mcp add --scope project playwright -- npx -y @playwright/mcp@0.0.82`. These are only written for projects without a `.mcp.json`; installs and upgrades never add to, change or remove an existing one.

### Hooks (`.claude/settings.json`)

| Hook | Action |
|------|--------|
| `SessionStart` | `session-start.cjs`: task counts, leftover in-progress claims, next ready task, into Claude's context |
| `PostToolUse` on `Edit\|Write` | `post-edit.cjs`: runs the project's own eslint `--fix` on JS/TS/Vue/Svelte/Astro files, plus `npm audit --audit-level=high` when the root `package.json` changes. Remaining problems go back to Claude as context; the hook never blocks. |

The hooks are Node scripts (`.cjs`, so they work in `"type": "module"` projects) reading the hook JSON from stdin, and they work the same on Windows, macOS and Linux. V5's inline hooks used `$CLAUDE_FILE_PATHS`, which Claude Code doesn't set, so they never linted anything.

### Permissions

- **Allowed:** reads anywhere; edits in `src/`, `tests/`, `public/`, `.claude/`; safe git commands; project test/lint/build scripts; vitest/jest/playwright; lighthouse + axe
- **Denied:** reads of `.env` / `.ssh` / `.aws` / secrets; package installs; `npx -y`; `curl` / `wget`; `rm -rf`; `git push`; `git reset --hard`; editing `tasks/tasks.db` directly

Personal overrides go in `.claude/settings.local.json` (created empty, never overwritten).

---

## Upgrading

```bash
cd your-project
node /path/to/agentic-workflow-template/bootstrap.js --dry-run   # see the plan
node /path/to/agentic-workflow-template/bootstrap.js             # or: upgrade.js
```

Pre-V6 installs are detected by their layout (CLAUDE.md + `.claude/agents/` + `tasks/cli.js`; the V5→V6 path is covered by the test suite). No questions asked: answers come from `.claude/agentic-workflow.json`, or are recovered from your existing files on pre-V6 installs.

### What changed in V6

- Agents are spawned as real agent types (V5 used `general-purpose` + "read this file", which ignored their tool limits and models)
- Per-agent `model` / `effort` / `disallowedTools` / `memory` frontmatter; the reviewer is read-only
- `task-pipeline` workflow + `/work-task`, `/decompose`, `/dry-run`, `/wrap-up` skills
- Model **and effort** routing; fix rounds inherit the tier, last round escalates
- Working hooks (V5's did nothing) and permission rules in the current syntax
- DB: file locking, self-migrating schema (the `migrate-*.js` scripts are gone), `--blocked-by` tasks actually unblock, `claim --json`, `route`, `preflight`, `brief`, `artifact save --stdin`
- Merge-based installer that works on existing projects, with `--dry-run` and timestamped backups
- CLAUDE.md orchestrator rules scoped to the main session, so subagents no longer read "never write code"

---

## Development

`npm test` runs the end-to-end suite in a temp dir: a fresh install, an install over an existing project, a real V5→V6 upgrade built from git history, the CLI routing, DB lock contention, and the workflow script against a mock agent runtime.

---

## License

MIT — use this template for any project, personal or commercial.
