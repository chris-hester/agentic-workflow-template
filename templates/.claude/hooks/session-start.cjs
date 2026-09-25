#!/usr/bin/env node
// SessionStart hook. Stdout is added to Claude's context, so keep it short:
// task DB status, leftover in-progress claims, and the next ready task.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const tasksDir = path.join(projectDir, 'tasks');

try {
  if (!fs.existsSync(path.join(tasksDir, 'cli.js'))) process.exit(0);
  if (!fs.existsSync(path.join(tasksDir, 'node_modules', 'sql.js'))) {
    console.log('Task CLI dependencies are missing. Ask the user to run: npm install --prefix tasks');
    process.exit(0);
  }
  const res = spawnSync(process.execPath, [path.join(tasksDir, 'cli.js'), 'brief'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (res.stdout) process.stdout.write(res.stdout);
} catch (_) {
  // Never block session start.
}
process.exit(0);
