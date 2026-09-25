#!/usr/bin/env node
// PostToolUse hook for Edit|Write. Claude Code passes the tool call as JSON on
// stdin (there is no $CLAUDE_FILE_PATHS variable). Lints the edited file with
// the project's own eslint and audits dependencies when package.json changes.
// Problems are fed back to Claude as additionalContext; the hook never blocks.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LINTABLE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro']);
const MAX_LINES = 30;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Windows needs a shell to run .cmd shims, and the shell joins args unquoted.
function run(cmd, args, cwd, timeout) {
  const win = process.platform === 'win32';
  const q = s => (win && /\s/.test(s) ? `"${s}"` : s);
  const res = win
    ? spawnSync([cmd, ...args].map(q).join(' '), { cwd, encoding: 'utf8', timeout, shell: true })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout });
  return { status: res.status, output: ((res.stdout || '') + (res.stderr || '')).trim() };
}

function tail(text) {
  const lines = text.split(/\r?\n/);
  return lines.length > MAX_LINES ? ['…', ...lines.slice(-MAX_LINES)].join('\n') : text;
}

function main() {
  const input = readInput();
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!filePath) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
  const abs = path.resolve(projectDir, filePath);
  const rel = path.relative(projectDir, abs);
  if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) return;

  const messages = [];

  const eslintBin = path.join(projectDir, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
  if (LINTABLE.has(path.extname(abs)) && fs.existsSync(eslintBin) && fs.existsSync(abs)) {
    const res = run(eslintBin, ['--fix', abs], projectDir, 60000);
    if (res.status !== 0 && res.output) messages.push(`eslint found problems in ${rel} after --fix:\n${tail(res.output)}`);
  }

  if (path.basename(abs) === 'package.json' && path.dirname(abs) === projectDir) {
    const res = run('npm', ['audit', '--audit-level=high'], projectDir, 90000);
    if (res.status !== 0 && res.output) messages.push(`npm audit reports high/critical vulnerabilities:\n${tail(res.output)}`);
  }

  if (messages.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: messages.join('\n\n') },
    }));
  }
}

try {
  main();
} catch (_) {
  // A broken hook must never break the edit loop.
}
process.exit(0);
