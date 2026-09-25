---
name: wrap-up
description: Write the end-of-session handoff summary to .claude/handoffs/. Use when the user says "done", "wrap up", "end session", or when all queued tasks are finished.
---

# Wrap up the session

1. Gather state:
   ```bash
   node tasks/cli.js stats
   node tasks/cli.js list --status in_progress
   node tasks/cli.js list --status blocked
   node tasks/cli.js next
   ```
2. From this conversation, collect the tasks completed this session (outcome + fix rounds), tasks blocked (reason), follow-ups created, and tasks auto-unblocked.
3. Tasks still `in_progress` that no agent is working on: ask the user whether to release them (`node tasks/cli.js release <id>`) so the next session doesn't treat them as claimed.
4. Write `.claude/handoffs/session-<YYYY-MM-DD>.md`. If that file already exists, append a new `## Session <HH:MM>` section instead of overwriting.

```markdown
# Session Summary — <date>

## Completed
- Task #<id>: <title> (<PASS | PASS_WITH_WARNINGS>, <N> fix rounds)

## Blocked
- Task #<id>: <title> — <reason>

## Still In Progress
- Task #<id>: <title>

## Follow-ups Created / Auto-Unblocked
- ...

## Next Session
- Task #<id> (<priority>) — <why this is next>
```

5. Tell the user where the file is, in one line.
