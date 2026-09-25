#!/usr/bin/env node
// End-to-end checks for the installer, task CLI, hooks and the task-pipeline
// workflow logic. No test framework — run with `npm test` from the repo root.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'awt-test-'));
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    failures++;
    console.log('  \x1b[31m✗ ' + name + '\x1b[0m\n    ' + (err.stack || err).toString().split('\n').slice(0, 6).join('\n    '));
  }
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const node = (args, opts = {}) => execFileSync(process.execPath, args, { encoding: 'utf8', ...opts });
const bootstrap = (dir, extra = []) => node([path.join(ROOT, 'bootstrap.js'), '--target', dir, '--yes', '--skip-deps', ...extra], { input: '' });
const cli = (dir, args, opts = {}) => node([path.join(dir, 'tasks', 'cli.js'), ...args], { cwd: dir, ...opts });

// One real npm install, copied into each scenario (keeps the suite fast).
let depsCache;
function withDeps(dir) {
  if (!depsCache) {
    depsCache = path.join(TMP, '_deps');
    fs.mkdirSync(depsCache);
    fs.copyFileSync(path.join(ROOT, 'templates', 'tasks', 'package.json'), path.join(depsCache, 'package.json'));
    execFileSync('npm install --no-audit --no-fund --silent', { cwd: depsCache, shell: true });
  }
  fs.cpSync(path.join(depsCache, 'node_modules'), path.join(dir, 'tasks', 'node_modules'), { recursive: true });
}

function scenario(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  console.log('Temp dir: ' + TMP + '\n');

  // ─── Fresh install ───────────────────────────────────────────────────────
  console.log('Fresh install');
  const fresh = scenario('fresh');
  await test('creates the full file set with a manifest', () => {
    bootstrap(fresh);
    for (const rel of ['CLAUDE.md', '.claude/agents/reviewer.md', '.claude/skills/work-task/SKILL.md', '.claude/workflows/task-pipeline.js', '.claude/hooks/post-edit.cjs', '.claude/settings.json', '.mcp.json', 'tasks/cli.js', '.claude/agentic-workflow.json']) {
      assert(exists(fresh, rel), 'missing ' + rel);
    }
    assert.strictEqual(JSON.parse(read(fresh, '.claude/agentic-workflow.json')).version, require(path.join(ROOT, 'package.json')).version);
  });
  await test('no unrendered {{TOKENS}} remain', () => {
    const walk = d => fs.readdirSync(d).flatMap(n => {
      const p = path.join(d, n);
      return fs.statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p];
    });
    const leftovers = walk(fresh).filter(p => /\{\{[A-Z_]+\}\}/.test(fs.readFileSync(p, 'utf8')));
    assert.deepStrictEqual(leftovers, []);
  });
  await test('re-running is a no-op (idempotent, no backups)', () => {
    const out = bootstrap(fresh);
    assert(!/~ update|≈ merge/.test(out), out);
    assert(!exists(fresh, '.claude/backups'));
  });
  await test('agent frontmatter uses real agent types with models', () => {
    const reviewer = read(fresh, '.claude/agents/reviewer.md');
    assert(/^model: opus$/m.test(reviewer) && /^disallowedTools: Write, Edit, NotebookEdit$/m.test(reviewer) && /^memory: project$/m.test(reviewer));
    for (const f of fs.readdirSync(path.join(fresh, '.claude', 'agents'))) {
      assert(!/general-purpose/.test(read(fresh, '.claude/agents/' + f)), f);
    }
  });

  // ─── Install over an existing, non-template project ─────────────────────
  console.log('\nInstall over an existing project');
  const existing = scenario('existing');
  fs.writeFileSync(path.join(existing, 'package.json'), JSON.stringify({ name: 'my-shop', type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3', next: '^15', typescript: '^5', tailwindcss: '^4' } }));
  fs.writeFileSync(path.join(existing, 'CLAUDE.md'), '# My Shop\n\nUse pnpm. Never touch legacy/.\n');
  fs.mkdirSync(path.join(existing, '.claude'));
  fs.writeFileSync(path.join(existing, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(pnpm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2));
  fs.writeFileSync(path.join(existing, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }));
  fs.writeFileSync(path.join(existing, '.gitignore'), 'node_modules/\n.env\n');

  await test('--dry-run writes nothing', () => {
    const out = bootstrap(existing, ['--dry-run']);
    assert(/DRY RUN/.test(out));
    assert(!exists(existing, '.claude/agents'));
    assert.strictEqual(read(existing, 'CLAUDE.md'), '# My Shop\n\nUse pnpm. Never touch legacy/.\n');
  });
  await test('keeps the user CLAUDE.md content and appends the managed block', () => {
    bootstrap(existing);
    const md = read(existing, 'CLAUDE.md');
    assert(md.startsWith('# My Shop\n\nUse pnpm. Never touch legacy/.'));
    assert(md.includes('<!-- agentic-workflow:start') && md.includes('<!-- agentic-workflow:end -->'));
    assert(exists(existing, '.claude/backups'));
  });
  await test('merges settings.json (user keys, allow rules and hooks kept)', () => {
    const s = JSON.parse(read(existing, '.claude/settings.json'));
    assert(!s.permissions.deny.some(r => r === 'Bash(git push *)' || r === 'Bash(git push)'), 'plain pushes must not be denied');
    assert.strictEqual(s.model, 'opus');
    assert(s.permissions.allow.includes('Bash(pnpm test)') && s.permissions.allow.includes('Bash(node tasks/cli.js *)'));
    assert(s.hooks.Stop && s.hooks.PostToolUse && s.hooks.SessionStart);
  });
  await test('leaves an existing .mcp.json alone; merges .gitignore', () => {
    const m = JSON.parse(read(existing, '.mcp.json'));
    assert.deepStrictEqual(Object.keys(m.mcpServers), ['github']);
    const gi = read(existing, '.gitignore');
    assert(gi.startsWith('node_modules/\n.env\n') && gi.includes('tasks/*.db') && gi.split('\n').filter(l => l === 'node_modules/').length === 1);
  });
  await test('detects stack and test command from package.json', () => {
    const t = JSON.parse(read(existing, '.claude/agentic-workflow.json')).tokens;
    assert.strictEqual(t.PROJECT_NAME, 'my-shop');
    assert.strictEqual(t.TEST_COMMAND, 'npm test');
    assert(/Next\.js/.test(t.TECH_STACK) && /Tailwind/.test(t.TECH_STACK));
    assert(read(existing, '.claude/agents/developer.md').includes('\nnpm test\n'));
  });
  await test('hooks run under "type": "module" and read stdin JSON', () => {
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(existing, 'src', 'x.ts') }, cwd: existing });
    const r = spawnSync(process.execPath, [path.join(existing, '.claude', 'hooks', 'post-edit.cjs')], { input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: existing } });
    assert.strictEqual(r.status, 0, r.stderr);
    const s = spawnSync(process.execPath, [path.join(existing, '.claude', 'hooks', 'session-start.cjs')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: existing } });
    assert.strictEqual(s.status, 0, s.stderr);
    assert(/npm install --prefix tasks/.test(s.stdout), 'expected missing-deps hint, got: ' + s.stdout);
  });
  await test('post-edit hook reports eslint failures as additionalContext', () => {
    const bin = path.join(existing, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(existing, 'fake-eslint.cjs');
    fs.writeFileSync(fake, 'console.log("x.ts:1:1 error no-undef"); process.exit(1);');
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'eslint.cmd'), `@node "${fake}" %*\r\n`);
    else { fs.writeFileSync(path.join(bin, 'eslint'), `#!/bin/sh\nnode "${fake}" "$@"\n`); fs.chmodSync(path.join(bin, 'eslint'), 0o755); }
    fs.mkdirSync(path.join(existing, 'src'), { recursive: true });
    fs.writeFileSync(path.join(existing, 'src', 'x.ts'), 'foo()\n');
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } });
    const r = spawnSync(process.execPath, [path.join(existing, '.claude', 'hooks', 'post-edit.cjs')], { input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: existing } });
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert(/no-undef/.test(out.hookSpecificOutput.additionalContext));
  });

  await test('custom agents are kept and extraReviewers survive re-runs', () => {
    const uiux = '---\nname: ui-ux\ndescription: visual QA\n---\nbody\n';
    fs.writeFileSync(path.join(existing, '.claude', 'agents', 'ui-ux.md'), uiux);
    const out = bootstrap(existing);
    assert(/custom agent — not touched/.test(out) && /"extraReviewers"/.test(out), out);
    const mp = path.join(existing, '.claude', 'agentic-workflow.json');
    fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(fs.readFileSync(mp, 'utf8')), extraReviewers: [{ agent: 'ui-ux', when: 'pm' }] }, null, 2));
    const again = bootstrap(existing);
    assert(!/"extraReviewers": \[\{/.test(again), 'should not re-suggest an agent that is already wired');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(mp, 'utf8')).extraReviewers, [{ agent: 'ui-ux', when: 'pm' }]);
    assert.strictEqual(read(existing, '.claude/agents/ui-ux.md'), uiux);
  });
  await test('claim payload lists extra reviewers only for matching dimensions', () => {
    withDeps(existing);
    const add = args => Number(cli(existing, ['add', ...args]).match(/#(\d+)/)[1]);
    const ui = add(['--title', 'Build pricing page layout', '--files', 'src/a.astro,src/b.astro', '--description', 'x'.repeat(120)]);
    const util = add(['--title', 'Refactor date util', '--files', 'src/d.ts,src/e.ts', '--description', 'y'.repeat(120)]);
    assert.deepStrictEqual(JSON.parse(cli(existing, ['route', String(ui), '--json'])).extra_reviewers, ['ui-ux']);
    assert.deepStrictEqual(JSON.parse(cli(existing, ['route', String(util), '--json'])).extra_reviewers, []);
  });

  // ─── Upgrade a real V5 install ───────────────────────────────────────────
  console.log('\nUpgrade from V5 (the "feat: V5" commit)');
  const v5src = scenario('_v5src');
  const v5 = scenario('v5project');
  let v5ok = true;
  try {
    // Relative tar path: GNU tar on Windows reads "C:" as a remote host.
    const v5commit = execFileSync('git', ['log', '--format=%H', '-1', '--grep=^feat: V5'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!v5commit) throw new Error('V5 commit not found in history');
    execFileSync('git', ['archive', '--format=tar', '-o', path.join(v5src, 'v5.tar'), v5commit], { cwd: ROOT });
    execFileSync('tar', ['-xf', 'v5.tar'], { cwd: v5src });
  } catch (err) {
    v5ok = false;
    console.log('  (skipped — git archive/tar unavailable: ' + err.message.split('\n')[0] + ')');
  }
  if (v5ok) {
    await test('V5 bootstrap + tasks created with the old CLI', () => {
      // Render V5's templates exactly like its bootstrap did (its readline
      // prompt drops piped stdin, so it can't be driven from here).
      const tokens = { PROJECT_NAME: 'Old Site', PROJECT_DESCRIPTION: 'A site', TECH_STACK: 'Astro + Tailwind', FRAMEWORK: 'Astro', STYLING: 'Tailwind', CMS: 'none', HOSTING: 'Netlify', TESTING: 'vitest', BRAND_COLORS: 'TBD', FONTS: 'TBD', SECURITY_KEYWORDS: 'API, form, auth' };
      const copy = (from, to) => {
        for (const n of fs.readdirSync(from)) {
          const src = path.join(from, n);
          const dest = path.join(to, n);
          if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dest, { recursive: true }); copy(src, dest); continue; }
          let text = fs.readFileSync(src, 'utf8');
          for (const [k, v] of Object.entries(tokens)) text = text.split('{{' + k + '}}').join(v);
          fs.writeFileSync(dest, text);
        }
      };
      copy(path.join(v5src, 'templates'), v5);
      withDeps(v5);
      assert(exists(v5, '.claude/ORCHESTRATION.md') && exists(v5, 'tasks/cli.js'));
      cli(v5, ['add', '--title', 'Base layout', '--priority', 'HIGH', '--files', 'src/a.astro,src/b.astro,src/c.astro']);
      cli(v5, ['add', '--title', 'Hero', '--blocked-by', '1', '--files', 'src/hero.astro']); // V5: stays 'ready' with blocked_by
      // User edits to preserve.
      fs.appendFileSync(path.join(v5, 'CLAUDE.md'), '\nAlways use pnpm.\n');
      const md = read(v5, 'CLAUDE.md').replace('| | Astro + Tailwind | [Fill in rationale] |', '| 2026-05-01 | Astro + Tailwind | static first |');
      fs.writeFileSync(path.join(v5, 'CLAUDE.md'), md);
    });
    await test('upgrade auto-detected, no questions asked', () => {
      const out = node([path.join(ROOT, 'bootstrap.js'), '--target', v5, '--skip-deps'], { input: '' });
      assert(/UPGRADE a pre-V6 install/.test(out), out);
    });
    await test('CLAUDE.md: old workflow sections replaced, user content kept', () => {
      const md = read(v5, 'CLAUDE.md');
      assert(!/## Forbidden Actions/.test(md) && !/general-purpose" \+ custom/.test(md));
      assert(md.includes('<!-- agentic-workflow:start'));
      assert(md.includes('| 2026-05-01 | Astro + Tailwind | static first |'));
      assert(md.includes('Always use pnpm.'));
      assert(md.startsWith('# Old Site - Development Log'));
    });
    await test('settings.json: broken V5 hooks and ENABLE_TOOL_SEARCH removed, legacy :* rules deduped', () => {
      const raw = read(v5, '.claude/settings.json');
      assert(!raw.includes('CLAUDE_FILE_PATHS') && !raw.includes('ENABLE_TOOL_SEARCH'));
      const s = JSON.parse(raw);
      assert(!s.permissions.allow.includes('Bash(node tasks/cli.js:*)'));
      assert(s.permissions.allow.includes('Bash(node tasks/cli.js *)'));
      assert.strictEqual(s.hooks.PostToolUse.length, 1);
      // V5 blocked every push; V6 lifts that and blocks force pushes only.
      assert(!s.permissions.deny.includes('Bash(git push *)'));
      assert(s.permissions.deny.includes('Bash(git push *--force*)'));
    });
    await test('.mcp.json untouched (V5 servers and pins kept, nothing added)', () => {
      const m = JSON.parse(read(v5, '.mcp.json'));
      assert.deepStrictEqual(Object.keys(m.mcpServers).sort(), ['chrome-devtools', 'playwright', 'shadcn']);
      assert(m.mcpServers['chrome-devtools'].args.includes('chrome-devtools-mcp@1.1.1'));
    });
    await test('tokens recovered and deprecated files removed', () => {
      const t = JSON.parse(read(v5, '.claude/agentic-workflow.json')).tokens;
      assert.strictEqual(t.PROJECT_NAME, 'Old Site');
      assert.strictEqual(t.TEST_COMMAND, 'npx vitest run');
      assert(!exists(v5, 'tasks/migrate-v4-artifacts.js'));
      assert(exists(v5, '.claude/workflows/task-pipeline.js'));
    });
    await test('DB migrated in place: tasks kept, effort column added', () => {
      const t = JSON.parse(cli(v5, ['route', '1', '--json']));
      assert.strictEqual(t.title, 'Base layout');
      assert.deepStrictEqual([t.model, t.effort], ['sonnet', 'high']); // legacy implicit 'sonnet' re-inferred
    });
    await test('V5 "ready with blocked_by" task unblocks when its dependency completes', () => {
      cli(v5, ['claim', '1', '--agent', 'developer']);
      const out = cli(v5, ['complete', '1', '--summary', 'done']);
      assert(/Auto-unblocked: Task #2/.test(out), out);
      assert(/#2/.test(cli(v5, ['next'])));
    });
  }

  // ─── Task CLI ────────────────────────────────────────────────────────────
  console.log('\nTask CLI');
  withDeps(fresh);
  await test('routing: haiku / sonnet / opus / CRITICAL, reviews never none for CRITICAL', () => {
    cli(fresh, ['add', '--title', 'Typo', '--files', 'a.ts', '--description', 'fix typo']);                         // 1
    cli(fresh, ['add', '--title', 'Feature', '--files', 'a.ts,b.ts', '--description', 'x'.repeat(150)]);              // 2
    cli(fresh, ['add', '--title', 'Big', '--files', 'a,b,c,d,e']);                                                    // 3
    cli(fresh, ['add', '--title', 'Hotfix', '--priority', 'CRITICAL', '--files', 'a.ts', '--description', 'short']); // 4
    const r = id => JSON.parse(cli(fresh, ['route', String(id), '--json']));
    assert.deepStrictEqual([r(1).model, r(1).effort, r(1).reviews], ['haiku', 'default', 'none']);
    assert.deepStrictEqual([r(2).model, r(2).effort], ['sonnet', 'medium']);
    assert.deepStrictEqual([r(3).model, r(3).effort], ['opus', 'high']);
    assert.deepStrictEqual([r(4).model, r(4).effort], ['opus', 'xhigh']);
    assert.notStrictEqual(r(4).reviews, 'none');
  });
  await test('fix tasks inherit the parent tier and escalate on iteration 3', () => {
    cli(fresh, ['claim', '2', '--agent', 'developer']);
    cli(fresh, ['add', '--title', 'Fix: null check', '--parent-task', '2', '--iteration', '1']); // 5
    cli(fresh, ['add', '--title', 'Fix: null check', '--parent-task', '2', '--iteration', '3']); // 6
    const r = id => JSON.parse(cli(fresh, ['route', String(id), '--json']));
    assert.deepStrictEqual([r(5).model, r(5).effort], ['sonnet', 'medium']); // V5 would have picked haiku
    assert.deepStrictEqual([r(6).model, r(6).effort], ['opus', 'high']);
  });
  await test('explicit --model pins routing', () => {
    cli(fresh, ['add', '--title', 'Pinned', '--model', 'sonnet']); // 7
    cli(fresh, ['update', '1', '--model', 'fable']);
    const r = id => JSON.parse(cli(fresh, ['route', String(id), '--json']));
    assert.strictEqual(r(7).model, 'sonnet');
    assert.strictEqual(r(1).model, 'fable');
  });
  await test('claim --json returns the workflow payload', () => {
    const p = JSON.parse(cli(fresh, ['claim', '3', '--agent', 'developer', '--json']));
    assert.deepStrictEqual(p.files_affected, ['a', 'b', 'c', 'd', 'e']);
    for (const k of ['id', 'title', 'model', 'effort', 'reviews', 'context_files', 'iteration']) assert(k in p, k);
  });
  await test('--blocked-by creates a blocked task; preflight flags it', () => {
    cli(fresh, ['add', '--title', 'Later', '--blocked-by', '4']); // 8
    assert(/blocked/.test(cli(fresh, ['get', '8'])));
    const pf = JSON.parse(cli(fresh, ['preflight', '8', '--json']));
    assert(!pf.ok && pf.problems.some(p => /#4/.test(p)));
  });
  await test('artifact save --stdin keeps quotes, $vars and backticks intact', () => {
    const body = 'FILES_MODIFIED:\n- src/a.ts - uses `$HOME` and "quotes" and \'single\'\n';
    cli(fresh, ['artifact', 'save', '3', '--type', 'dev_report', '--iteration', '2', '--stdin'], { input: body });
    assert.strictEqual(cli(fresh, ['artifact', 'get', '3', '--type', 'dev_report']).trim(), body.trim());
  });
  await test('concurrent writers do not lose artifacts (DB lock)', async () => {
    const N = 8;
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(fresh, 'tasks', 'cli.js'), 'artifact', 'save', '2', '--type', 'review_report', '--content', 'r' + i], { cwd: fresh });
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error('writer ' + i + ' exited ' + code))));
    })));
    const list = cli(fresh, ['artifact', 'list', '2']);
    assert.strictEqual((list.match(/review_report/g) || []).length, N, list);
    assert(!exists(fresh, 'tasks/tasks.db.lock'), 'lock file left behind');
  });
  await test('pinned model without effort gets the effort its priority implies', () => {
    const add = args => Number(cli(fresh, ['add', ...args]).match(/#(\d+)/)[1]);
    const crit = add(['--title', 'Pinned critical', '--priority', 'CRITICAL', '--model', 'opus']);
    const small = add(['--title', 'Pinned opus small', '--model', 'opus', '--files', 'a.ts']);
    const maxed = add(['--title', 'Pinned effort', '--model', 'opus', '--effort', 'max']);
    const r = id => JSON.parse(cli(fresh, ['route', String(id), '--json']));
    assert.deepStrictEqual([r(crit).model, r(crit).effort], ['opus', 'xhigh']);
    assert.deepStrictEqual([r(small).model, r(small).effort], ['opus', 'high']);
    assert.deepStrictEqual([r(maxed).model, r(maxed).effort], ['opus', 'max']);
  });
  await test('pm review: tests in acceptance criteria or "testimonial" no longer suppress it', () => {
    const add = args => Number(cli(fresh, ['add', ...args]).match(/#(\d+)/)[1]);
    const r = id => JSON.parse(cli(fresh, ['route', String(id), '--json'])).reviews;
    const long = ' Done when the page renders correctly on mobile and the unit tests pass.'.padEnd(120, '.');
    assert(r(add(['--title', 'Rework gallery grid', '--files', 'a,b', '--description', long])).includes('pm'));
    assert(r(add(['--title', 'Unify testimonial wording', '--files', 'a,b', '--description', 'Testimonial section copy on the page.'.padEnd(120, '.')])).includes('pm'));
    assert(!r(add(['--title', 'Unit tests for Header', '--files', 'a,b', '--description', long])).includes('pm'));
    assert(!r(add(['--title', 'Follow-up: alt text', '--files', 'a,b', '--description', long])).includes('pm'));
  });
  await test('brief prints a compact status', () => {
    assert(/Task DB: \d+ total/.test(cli(fresh, ['brief'])));
  });

  // ─── Workflow script logic (mock agent runtime) ──────────────────────────
  console.log('\nWorkflow: task-pipeline.js');
  const src = read(path.join(ROOT, 'templates'), '.claude/workflows/task-pipeline.js');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const body = src.replace(/^export const meta =/m, 'const meta =');
  const runWorkflow = async (args, agentImpl) => {
    const calls = [];
    const logs = [];
    const agent = async (prompt, opts) => { calls.push({ prompt, ...opts }); return agentImpl(prompt, opts, calls); };
    const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)));
    const result = await new AsyncFunction('args', 'agent', 'parallel', 'log', body)(args, agent, parallel, m => logs.push(m));
    return { result, calls, logs };
  };
  const payload = (id, files, extra = {}) => ({ id, title: 'T' + id, priority: 'MEDIUM', description: 'd', files_affected: files, fix_required: null, parent_task_id: null, iteration: 1, model: 'sonnet', effort: 'medium', reviews: 'qa', context_files: ['requirements-summary.md'], ...extra });
  const dev = { status: 'done', summary: 'did it', files_modified: ['a.ts'], tests: 'ok', issues: [] };
  const pass = { status: 'PASS', summary: 'ok', critical: [], warnings: [] };
  const fail = { status: 'FAIL', summary: 'bad', critical: [{ issue: 'null deref', location: 'a.ts:3', fixed_when: 'guarded' }], warnings: [] };

  await test('meta is a pure literal and the script parses', () => {
    assert(/^export const meta = \{/.test(src));
    new AsyncFunction('args', 'agent', 'parallel', 'log', body); // throws on syntax error
  });
  await test('PASS path: developer then reviewer, custom agent types, claimed routing', async () => {
    const { result, calls } = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, (p, o) => (o.agentType === 'developer' ? dev : pass));
    assert.strictEqual(result.results[0].outcome, 'PASS');
    assert.deepStrictEqual(calls.map(c => c.agentType), ['developer', 'reviewer']);
    assert.deepStrictEqual([calls[0].model, calls[0].effort], ['sonnet', 'medium']);
    assert(calls[1].prompt.includes('REVIEW DIMENSIONS: qa'));
  });
  await test('reviews "none" skips review; haiku "default" effort is omitted', async () => {
    const { result, calls } = await runWorkflow({ tasks: [payload(1, ['a.ts'], { reviews: 'none', model: 'haiku', effort: 'default' })] }, () => dev);
    assert.strictEqual(result.results[0].outcome, 'PASS');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].model, 'haiku');
    assert(!('effort' in calls[0]));
  });
  await test('FAIL → fix → scoped verify PASS; fix prompt carries the finding', async () => {
    let reviews = 0;
    const { result, calls } = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, (p, o) => {
      if (o.agentType === 'developer') return dev;
      return reviews++ === 0 ? fail : pass;
    });
    assert.strictEqual(result.results[0].outcome, 'PASS');
    assert.strictEqual(result.results[0].fix_rounds, 1);
    const fix = calls[2];
    assert(fix.prompt.includes('FIX ROUND 1 of 3') && fix.prompt.includes('null deref') && fix.prompt.includes('--iteration 2'));
    assert(calls[3].prompt.startsWith('REVIEW MODE: SCOPED FIX VERIFICATION'));
    assert.strictEqual(calls[3].model, 'sonnet');
  });
  await test('circuit breaker: 3 fix rounds, last one escalated, then FAILED_REVIEW', async () => {
    const { result, calls, logs } = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, (p, o) => (o.agentType === 'developer' ? dev : fail));
    const r = result.results[0];
    assert.strictEqual(r.outcome, 'FAILED_REVIEW');
    assert.strictEqual(r.fix_rounds, 3);
    const fixes = calls.filter(c => /^fix /.test(c.label));
    assert.deepStrictEqual(fixes.map(c => c.model), ['sonnet', 'sonnet', 'opus']);
    assert.strictEqual(calls.length, 8);
    assert(logs.some(l => /escalating to opus/.test(l)));
  });
  await test('warnings accumulate into PASS_WITH_WARNINGS', async () => {
    const warn = { ...pass, warnings: ['missing alt text'] };
    const { result } = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, (p, o) => (o.agentType === 'developer' ? dev : warn));
    assert.strictEqual(result.results[0].outcome, 'PASS_WITH_WARNINGS');
    assert.deepStrictEqual(result.results[0].warnings, ['missing alt text']);
  });
  await test('developer blocked → DEV_BLOCKED; null agent retried once then ERROR', async () => {
    const blocked = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, () => ({ ...dev, status: 'blocked', summary: 'needs zod' }));
    assert.strictEqual(blocked.result.results[0].outcome, 'DEV_BLOCKED');
    const dead = await runWorkflow({ tasks: [payload(1, ['a.ts'])] }, () => null);
    assert.strictEqual(dead.result.results[0].outcome, 'ERROR');
    assert.strictEqual(dead.calls.length, 2);
  });
  await test('lanes: overlapping files run sequentially, others in parallel', async () => {
    const order = [];
    let active = 0; let maxActive = 0;
    const { result, logs } = await runWorkflow({ tasks: [payload(1, ['a.ts']), payload(2, ['a.ts', 'b.ts']), payload(3, ['z.ts'])] }, async (p, o) => {
      active++; maxActive = Math.max(maxActive, active);
      order.push(o.label);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return o.agentType === 'developer' ? dev : pass;
    });
    assert.strictEqual(result.results.length, 3);
    assert(order.indexOf('review #1') < order.indexOf('develop #2'), 'task 2 started before task 1 finished: ' + order.join(', '));
    assert(maxActive >= 2, 'lanes did not run in parallel');
    assert(logs.some(l => /#1 → #2/.test(l)));
  });
  await test('extra reviewer runs in parallel; its FAIL drives the fix loop', async () => {
    let uiuxCalls = 0;
    const { result, calls } = await runWorkflow({ tasks: [payload(1, ['a.astro'], { reviews: 'qa,pm', extra_reviewers: ['ui-ux'] })] }, (p, o) => {
      if (o.agentType === 'developer') return dev;
      if (o.agentType === 'ui-ux') { uiuxCalls++; return { status: 'FAIL', summary: 'contrast', critical: [{ issue: 'cream-on-cream hover' }], warnings: ['tap target 40px'] }; }
      return pass;
    });
    assert.strictEqual(uiuxCalls, 1, 'ui-ux should only run in the initial review');
    assert(calls[1].agentType === 'reviewer' && calls[2].agentType === 'ui-ux');
    assert(calls[2].prompt.includes('FIX_MODE: false') && calls[2].prompt.includes('--type ui-ux_report'));
    const fix = calls.find(c => /^fix 1/.test(c.label));
    assert(fix.prompt.includes('[ui-ux] cream-on-cream hover'), fix.prompt);
    const r = result.results[0];
    assert.strictEqual(r.outcome, 'PASS_WITH_WARNINGS');
    assert.deepStrictEqual(r.warnings, ['[ui-ux] tap target 40px']);
  });
  await test('no tasks → error result instead of spawning', async () => {
    const { result, calls } = await runWorkflow({}, () => dev);
    assert(result.error && calls.length === 0);
  });

  console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
  if (!failures) fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main();
