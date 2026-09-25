---
name: decompose
description: Break a goal, feature or spec into tasks in the task DB using the decomposer agent, with user approval before anything is created. Use when the user says "decompose ..." or asks to plan work into tasks.
argument-hint: "<goal, or path to a spec file>"
---

# Decompose: $ARGUMENTS

1. **Spawn the decomposer** — `Agent` with `subagent_type: "decomposer"`. Pass the goal verbatim; if it names a spec file, pass the path and let the decomposer read it.

2. **Show the plan, don't create yet.** Present the decomposer's plan (title, group, priority, dependencies, one-line why). Ask the user to approve or edit. Apply their edits to the commands.

3. **Create the tasks** once approved. Run the `add` commands one at a time, in order, and note each new ID from the `✅ Task #N created` line.

4. **Wire dependencies between the new tasks** the plan described:
   ```bash
   node tasks/cli.js update <id> --blocked-by "<id>,<id>"
   ```
   Tasks with open dependencies move to `blocked` and auto-unblock when their dependencies complete.

5. **Show the result:** `node tasks/cli.js list`, then suggest `/dry-run <first task>` or `/work-task next`.
