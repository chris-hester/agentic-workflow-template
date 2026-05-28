# Agentic Workflow Template for Claude Code

A production-ready scaffold that sets up an orchestrated agentic coding workflow for Claude Code. Instead of Claude doing everything in a single context, this system splits work across specialized subagents, tracks all work in a SQLite task database, automates code review, and loops until quality gates pass.

---

## What This Is

This template bootstraps a complete agentic workflow system that:

- **Splits work across specialized subagents** — developer, QA reviewer, security reviewer, project manager reviewer, task manager, and researcher roles
- **Tracks all work in a SQLite task database** — with a full-featured CLI for task management
- **Automates code review** — with configurable review dimensions (QA, security, requirements alignment)
- **Auto-infers model selection** — haiku for simple fixes, sonnet for standard work, opus for complex architecture
- **Loops on review failures** — automatically spawns fix tasks and re-reviews until all quality gates pass
- **Supports parallel execution** — work on multiple tasks simultaneously with session isolation

Instead of asking Claude to "just build X," you:
1. Add a task to the database
2. Tell Claude "work on task 1"
3. The orchestrator spawns a developer subagent (isolated context)
4. The orchestrator spawns a reviewer subagent (covers QA + security + scope in one pass)
5. The orchestrator evaluates the review and decides PASS/FAIL
6. If FAIL, the system automatically creates fix tasks and loops Steps 3-5 until PASS

**Result:** Higher quality code, better separation of concerns, full audit trail, and the ability to work on multiple tasks in parallel.

---

## How It Works

### The 6-Step Workflow

When you say **"work on task 1"**, the orchestrator executes this loop:

| Step | Who | What |
|------|-----|------|
| **1. GET** | Orchestrator (you) | Run `node tasks/cli.js get <id>` to fetch task details |
| **2. CLAIM** | Orchestrator (you) | Run `node tasks/cli.js claim <id>` — auto-infers model, review dimensions, context files |
| **3. DEVELOP** | Developer subagent | Spawned via Task tool — reads `.claude/agents/developer.md`, implements the task, returns report |
| **4. REVIEW** | 3 reviewer subagents (parallel) | QA + Security + PM reviewers — each reads their `.md` file, reviews code, returns report |
| **5. EVALUATE** | Task-manager subagent | Reads all 3 review reports, applies decision matrix (PASS/FAIL/PASS_WITH_WARNINGS), updates DB |
| **6. LOOP** | Orchestrator (you) | If FAIL → create fix tasks → repeat Steps 3-5 until PASS |

**Key principles:**
- The **orchestrator (Claude in main context)** coordinates workflow but NEVER writes code or reviews
- **All implementation and review work is done by subagents** (spawned via the Task tool)
- Each subagent operates in an **isolated context** with its own instructions from `.claude/agents/*.md`
- The **orchestrator** manages the database (via `tasks/cli.js`) and makes PASS/FAIL decisions
- The system **loops automatically** on failures until quality gates pass

---

## Quick Start

### 1. Bootstrap Your Project

In your project directory, run:

```bash
npx agentic-workflow
```

Or if you've cloned this repo locally:

```bash
node /path/to/agentic-workflow-template/bootstrap.js
```

The bootstrap script will:
- Ask 10 questions about your project (name, tech stack, CMS, etc.)
- Generate all workflow files with your project-specific values
- Install task CLI dependencies
- Initialize the SQLite task database
- Print next steps

### 2. Fill In Context Files

The bootstrap creates template context files. Fill them in with your project specifics:

- `.claude/context/project-overview.md` — High-level project goals, target users, success criteria
- `.claude/context/design-system.md` — Brand colors, typography, spacing, component guidelines
- `.claude/context/requirements-summary.md` — Key features, acceptance criteria, constraints

These files are loaded by subagents to understand your project.

### 3. Create Your First Task

```bash
node tasks/cli.js add \
  --title "Build landing page hero section" \
  --priority HIGH \
  --description "Implement hero with headline, CTA button, and background image" \
  --category Development \
  --files-affected "src/components/Hero.tsx, src/pages/index.tsx"
```

### 4. Start Working

Tell Claude:

```
work on task 1
```

Claude will:
1. Fetch and claim the task
2. Spawn a developer subagent to implement it
3. Spawn a reviewer subagent (covers QA + security + scope)
4. Evaluate the review report
5. Loop on failures or complete on success
6. Suggest the next task

---

## What Gets Created

After running `bootstrap.js`, your project will have:

```
your-project/
├── .claude/
│   ├── agents/
│   │   ├── developer.md          # Developer subagent instructions
│   │   ├── reviewer.md           # Reviewer (QA + security + scope in one pass)
│   │   ├── decomposer.md         # Breaks goals into tasks
│   │   └── researcher.md         # Technical research agent
│   ├── context/
│   │   ├── project-overview.md   # (Template — fill this in)
│   │   ├── design-system.md      # (Template — fill this in)
│   │   └── requirements-summary.md # (Template — fill this in)
│   ├── ORCHESTRATION.md          # Full workflow guide for orchestrator
│   └── PROJECT.md                # Project requirements reference
├── tasks/
│   ├── cli.js                    # Task management CLI
│   ├── db.js                     # SQLite database interface
│   ├── package.json              # Task CLI dependencies
│   └── tasks.db                  # SQLite database (auto-created)
└── CLAUDE.md                     # Main instructions for Claude (orchestrator role)
```

All template files have project-specific values injected (project name, tech stack, CMS, etc.).

---

## Agents

The workflow uses 6 specialized subagent roles:

| Agent | File | Role |
|-------|------|------|
| **Developer** | `.claude/agents/developer.md` | Reads context, implements tasks, runs tests, reports results |
| **Reviewer** | `.claude/agents/reviewer.md` | Reviews QA (quality/tests/a11y/perf) + security (API/auth/inputs) + scope (requirements/UX) in a single pass |
| **Decomposer** | `.claude/agents/decomposer.md` | Breaks a goal/spec into a structured set of tasks with priorities and dependencies |
| **Researcher** | `.claude/agents/researcher.md` | Performs technical research before complex tasks |

Each agent is **spawned via the Task tool** with `subagent_type: "general-purpose"` and a prompt that instructs it to read its `.md` file and follow the instructions exactly.

---

## Task CLI

Manage tasks via the CLI in `tasks/`:

### Common Commands

```bash
# List tasks
node tasks/cli.js list                      # All tasks
node tasks/cli.js list --status ready       # Ready to work
node tasks/cli.js list --priority HIGH      # High priority only
node tasks/cli.js list --category Security  # Security tasks only

# Get task details
node tasks/cli.js get 1                     # Full details for task 1

# Add a new task
node tasks/cli.js add \
  --title "Implement user authentication" \
  --priority HIGH \
  --description "Add login/signup with JWT tokens" \
  --category Development \
  --files-affected "src/auth/*, src/api/login.ts"

# Claim a task (auto-infers model + reviews + context)
node tasks/cli.js claim 1 --agent developer

# Complete a task (orchestrator calls this after a passing review)
node tasks/cli.js complete 1 --summary "Hero section implemented and tested"

# View statistics
node tasks/cli.js stats                     # Overall progress

# Get next suggested task
node tasks/cli.js next                      # Based on priority + dependencies
```

### Multi-Session Support

Work on multiple tasks in parallel with session isolation:

```bash
# Suggest task distribution across N sessions
node tasks/cli.js suggest-batch --sessions 3

# Auto-assign tasks to sessions
node tasks/cli.js suggest-batch --sessions 3 --assign

# View active sessions
node tasks/cli.js session-active

# View tasks for a session
node tasks/cli.js session-tasks session-1

# Claim with session
node tasks/cli.js claim 5 --session session-2
```

Then tell Claude:
```
work on tasks for session-1
```

---

## Auto-Inference

When you **claim a task**, the CLI automatically infers:

### 1. Model Selection

| Task Type | Model | Rationale |
|-----------|-------|-----------|
| Priority: LOW + Category: Fix | `claude-haiku-4-5-20251001` | Simple bug fixes → fast model |
| Priority: TRIVIAL | `claude-haiku-4-5-20251001` | Trivial tasks → fast model |
| Priority: CRITICAL or 5+ files affected | `claude-opus-4-7` | Complex architecture → most capable model |
| Everything else | `claude-sonnet-4-6` | Standard work → balanced model |

### 2. Review Dimensions (Additive)

| Condition | Review Enabled |
|-----------|---------------|
| Always | ✓ QA Review |
| Task mentions security keywords (API, auth, env, etc.) | ✓ Security Review |
| Task adds user-facing features (new, add, build, implement) | ✓ PM Review (requirements) |

**Example:** A task titled "Build login API" → triggers QA + Security + PM (all 3).

**Security keywords:** `{{SECURITY_KEYWORDS}}` (injected from your bootstrap answers)

### 3. Context Files

| Review Type | Context Loaded |
|-------------|---------------|
| Full dev + all 3 reviews | All context files from `.claude/context/` |
| QA only | `project-overview.md`, `requirements-summary.md` |
| Security only | `project-overview.md` |

Fewer files loaded for simpler reviews = faster execution.

---

## Customization

After bootstrap, customize the workflow:

### 1. Context Files

Fill in `.claude/context/` with your project specifics:
- **project-overview.md** — Goals, users, success metrics
- **design-system.md** — Colors, fonts, spacing, components
- **requirements-summary.md** — Features, acceptance criteria

These are loaded by subagents to understand your project.

### 2. Agent Checklists

Edit `.claude/agents/reviewer.md` to adjust review criteria. The reviewer covers three dimensions in one pass — add project-specific items under each:
- **QA Review** — project-specific test requirements
- **Security Review** — custom security rules (e.g., HIPAA compliance)
- **Requirements Review** — brand voice guidelines, scope rules

### 3. Task Database Schema

Extend `tasks/db.js` to add custom fields:
- Add columns to tasks table (e.g., `estimated_hours`, `assignee`)
- Add CLI commands for custom workflows

---

## Parallel Tasks

Work on multiple tasks simultaneously:

```
work on task 5 and 6
```

The orchestrator will:
1. **Get + Claim** both tasks in parallel (2 bash calls)
2. **Spawn 2 developer subagents** in parallel (1 message, 2 Task calls)
3. **Spawn 2 reviewer subagents** in parallel (1 message, 2 Task calls)
4. **Orchestrator evaluates each review** sequentially (no subagent needed)
5. **Handle results independently:**
   - Task 5 passes → done
   - Task 6 fails → loop only task 6 (developer fix → re-review)

**Rules:**
- Same step across all tasks → single message with parallel tool calls
- Wait for ALL tasks to complete a step before advancing any to the next step
- Loop independently on failures

**Scales to N tasks** — the orchestrator batches the same step across all tasks.

---

## How This Differs from Standard Claude Workflow

| Standard Claude | Agentic Workflow Template |
|-----------------|---------------------------|
| Single context for everything | Orchestrator + specialized subagents |
| Claude writes code directly | Subagents write code, orchestrator coordinates |
| Manual tracking of tasks | SQLite database + CLI |
| No automated review | 3 parallel review subagents |
| No quality loop | Auto-fix and re-review until PASS |
| One task at a time | Parallel task execution with sessions |
| No audit trail | Full DB history of all work |

**Result:** Better code quality, clear separation of concerns, scalable to complex projects.

---

## License

MIT — Use this template for any project (personal or commercial).

---

## Contributing

This template is designed to be forked and customized. If you build improvements:
- Add custom agents (e.g., accessibility-reviewer, performance-auditor)
- Extend the task CLI (e.g., Gantt charts, time tracking)
- Integrate with external tools (e.g., Jira, Linear)

Share your enhancements via PRs or forks!

---

## Credits

Built for the Claude Code agentic workflow pattern.

**Happy agentic coding!** 🤖
