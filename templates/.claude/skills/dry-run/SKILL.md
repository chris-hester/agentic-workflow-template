---
name: dry-run
description: Preview how /work-task would handle one or more tasks — model, effort, review dimensions, preflight problems, parallel lanes — without claiming anything or spawning agents. Use when the user says "dry run task 7".
argument-hint: "<id> [id ...]"
---

# Dry run: $ARGUMENTS

Read-only. Don't claim, don't spawn agents, don't run the workflow.

For each ID (parallel Bash calls):
```bash
node tasks/cli.js route <id> --json
node tasks/cli.js preflight <id>
```

Then report:

```
Dry Run — Task #<id>: <title>
  Routing:   <model> / effort <effort>   (fix round 3 would escalate to <next tier>)
  Reviews:   <reviews>
  Context:   <context_files>
  Files:     <files_affected or "not listed">
  Preflight: ✅ | ❌ <problems> | ⚠ <notes>
  Agents:    <1 if reviews = none, else 2> now, up to 6 more if fix rounds run
```

With several tasks, also show the lanes: tasks whose `files_affected` overlap (or that list no files) run sequentially in one lane; the rest run in parallel.

Escalation ladder: haiku → sonnet/high, sonnet → opus/high, opus → opus/xhigh.
