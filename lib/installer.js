// Shared install/upgrade engine for bootstrap.js and upgrade.js.
//
// Every template file falls into one ownership class, so the same code path
// works for a fresh project, an existing codebase that never had the template,
// and any earlier template version:
//
//   managed  — template-owned (agents, skills, workflows, hooks, task CLI).
//              Overwritten; the previous version is backed up if it differed.
//   claudeMd — only the <!-- agentic-workflow:start/end --> block is ours.
//              Pre-V6 template CLAUDE.md files have their old workflow
//              sections swapped for the block; anything else is kept.
//   json     — .claude/settings.json is merged; an existing .mcp.json is left
//              alone (template servers are only suggested).
//   lines    — .gitignore: missing lines are appended.
//   seed     — context files and settings.local.json: created only if absent.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = require('../package.json').version;
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const MANIFEST = '.claude/agentic-workflow.json';
const BLOCK_START = '<!-- agentic-workflow:start';
const BLOCK_END = '<!-- agentic-workflow:end -->';

const DEPRECATED = [
  '.claude/context/context-manifest.json',
  '.claude/agents/qa-reviewer.md',
  '.claude/agents/security-ops.md',
  '.claude/agents/project-manager.md',
  '.claude/agents/task-manager.md',
  'tasks/migrate-sessions.js',
  'tasks/migrate-v3-model-reviews.js',
  'tasks/migrate-v4-artifacts.js',
];

// Hook commands shipped by V5 that never worked ($CLAUDE_FILE_PATHS is not set
// by Claude Code) or that the V6 hook scripts replace.
const LEGACY_HOOK_PATTERNS = [/\$CLAUDE_FILE_PATHS/, /^node tasks\/cli\.js stats$/];
const LEGACY_CLAUDE_SECTIONS = ['Role', 'Forbidden Actions', 'CLI Quick Reference', 'Workflow'];

const colors = { reset: '\x1b[0m', bright: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', red: '\x1b[31m', dim: '\x1b[2m' };
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}
function header(message) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(message, 'bright');
  log('='.repeat(60), 'cyan');
}

// ═══ DETECTION ═══

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function readManifest(targetDir) {
  return readJson(path.join(targetDir, MANIFEST));
}

function isLegacyInstall(targetDir) {
  return ['CLAUDE.md', '.claude/agents', 'tasks/cli.js'].every(p => fs.existsSync(path.join(targetDir, p)));
}

function allDeps(pkg) {
  return { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
}

// Best-guess answers from an existing codebase's package.json, used as prompt
// defaults (or as-is with --yes).
function detectDefaults(targetDir) {
  const pkg = readJson(path.join(targetDir, 'package.json'));
  const deps = allDeps(pkg);
  const has = name => Object.prototype.hasOwnProperty.call(deps, name);
  const pick = pairs => (pairs.find(([dep]) => has(dep)) || [])[1];

  const framework = pick([['next', 'Next.js'], ['astro', 'Astro'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['@remix-run/react', 'Remix'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['react', 'React'], ['express', 'Express']]) || '';
  const styling = pick([['tailwindcss', 'Tailwind CSS'], ['styled-components', 'styled-components'], ['@emotion/react', 'Emotion'], ['sass', 'Sass']]) || '';
  const testing = pick([['vitest', 'Vitest'], ['jest', 'Jest'], ['@playwright/test', 'Playwright'], ['mocha', 'Mocha']]) || '';
  const typescript = has('typescript') ? 'TypeScript' : '';

  return {
    projectName: (pkg && pkg.name) || path.basename(targetDir),
    description: (pkg && pkg.description) || '',
    techStack: [framework, typescript, styling].filter(Boolean).join(' + '),
    framework,
    styling: styling || 'none',
    cms: 'none',
    hosting: '',
    testing: testing || 'none',
    brandColors: 'skip',
    fonts: 'skip',
  };
}

function deriveTestCommand(testing, targetDir) {
  const pkg = readJson(path.join(targetDir, 'package.json'));
  const script = pkg && pkg.scripts && pkg.scripts.test;
  if (script && !/no test specified/.test(script)) return 'npm test';
  const t = (testing || '').toLowerCase();
  if (t.includes('vitest')) return 'npx vitest run';
  if (t.includes('jest')) return 'npx jest';
  if (t.includes('playwright')) return 'npx playwright test';
  if (t.includes('mocha')) return 'npx mocha';
  return 'echo "No tests configured"';
}

// ═══ TOKENS ═══

function tokensFromAnswers(answers, targetDir) {
  const cmsName = answers.cms.toLowerCase() === 'none' ? '' : answers.cms;
  const baseKeywords = 'API, form, fetch, POST, env, .env, token, auth, secret, cookie, session, input, validation, CSRF, XSS, redirect, sanitize';
  const tbd = v => (!v || v.toLowerCase() === 'skip' ? 'TBD — fill in .claude/context/design-system.md' : v);
  return {
    PROJECT_NAME: answers.projectName,
    PROJECT_DESCRIPTION: answers.description,
    TECH_STACK: answers.techStack,
    FRAMEWORK: answers.framework,
    STYLING: answers.styling,
    CMS: answers.cms,
    HOSTING: answers.hosting,
    TESTING: answers.testing,
    TEST_COMMAND: deriveTestCommand(answers.testing, targetDir),
    BRAND_COLORS: tbd(answers.brandColors),
    FONTS: tbd(answers.fonts),
    SECURITY_KEYWORDS: cmsName ? `${baseKeywords}, ${cmsName}` : baseKeywords,
  };
}

// Pre-manifest installs: recover the original answers from the rendered files.
// Only tokens used by managed files really matter here (context files are
// never re-rendered on upgrade), the rest fall back to detected defaults.
function extractLegacyTokens(targetDir) {
  const read = rel => {
    const p = path.join(targetDir, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const grab = (text, re) => {
    const m = text.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };
  const claude = read('CLAUDE.md');
  const overview = read('.claude/context/project-overview.md');
  const db = read('tasks/db.js');
  const developer = read('.claude/agents/developer.md');
  const orchestration = read('.claude/ORCHESTRATION.md');

  const t = {
    PROJECT_NAME: grab(claude, /^#\s+(.+?)\s+-\s+Development Log/m) || grab(overview, /\*\*Name:\*\*\s*(.+)/),
    TECH_STACK: grab(claude, /\*\*Tech Stack:\*\*\s*(.+)/),
    PROJECT_DESCRIPTION: grab(overview, /\*\*Description:\*\*\s*(.+)/),
    STYLING: grab(overview, /\*\*Styling:\*\*\s*(.+)/),
    CMS: grab(overview, /\*\*CMS\/Backend:\*\*\s*(.+)/),
    HOSTING: grab(overview, /\*\*Hosting:\*\*\s*(.+)/),
    TESTING: grab(developer, /npx\s+(\S+)\s+run/) || grab(orchestration, /npx\s+(\S+)\s+--version/),
    SECURITY_KEYWORDS: grab(db, /const SECURITY_KEYWORDS = '([^']+)'/),
  };
  const req = read('.claude/context/requirements-summary.md');
  t.FRAMEWORK = grab(req, /Follow\s+(.+?)\s+best practices/);

  const defaults = tokensFromAnswers({ ...detectDefaults(targetDir), brandColors: 'skip', fonts: 'skip' }, targetDir);
  for (const [k, v] of Object.entries(defaults)) {
    if (!t[k] || /\{\{/.test(t[k])) t[k] = v;
  }
  t.TEST_COMMAND = deriveTestCommand(t.TESTING, targetDir);
  return t;
}

function render(content, tokens) {
  let out = content;
  for (const [k, v] of Object.entries(tokens)) out = out.split('{{' + k + '}}').join(v);
  return out;
}

// ═══ FILE PLAN ═══

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function classify(rel) {
  if (rel === 'CLAUDE.md') return 'claudeMd';
  if (rel === '.claude/settings.json' || rel === '.mcp.json') return 'json';
  if (rel === '.gitignore') return 'lines';
  if (rel === '.claude/settings.local.json' || rel.startsWith('.claude/context/')) return 'seed';
  return 'managed';
}

const normalize = s => s.replace(/\r\n/g, '\n');

// ═══ MERGERS ═══

function extractBlock(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  return start === -1 || end === -1 ? null : text.slice(start, end + BLOCK_END.length);
}

function stripLegacySections(text, block) {
  const chunks = [];
  let cur = { title: null, lines: [] };
  for (const line of text.split('\n')) {
    const m = line.match(/^## (.+?)\s*$/);
    if (m) {
      chunks.push(cur);
      cur = { title: m[1], lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  chunks.push(cur);

  const out = [];
  let inserted = false;
  for (const c of chunks) {
    if (c.title && LEGACY_CLAUDE_SECTIONS.includes(c.title)) {
      if (!inserted) { out.push(block, ''); inserted = true; }
      if (c.lines.some(l => l.trim() === '---')) out.push('---', '');
      continue;
    }
    out.push(...c.lines);
  }
  return out.join('\n')
    .replace(/(\n---\s*)+\n---/g, '\n---')
    .replace(/\n{3,}/g, '\n\n');
}

function mergeClaudeMd(existing, rendered) {
  const block = extractBlock(rendered);
  if (existing === null) return { content: rendered, note: 'created' };
  existing = normalize(existing);
  const current = extractBlock(existing);
  if (current !== null) {
    return { content: existing.replace(current, () => block), note: 'workflow block updated' };
  }
  if (/^## Forbidden Actions/m.test(existing) || /You are the \*\*orchestrator\*\*/.test(existing)) {
    return { content: stripLegacySections(existing, block), note: 'old workflow sections replaced by managed block; your other sections kept' };
  }
  return { content: existing.trimEnd() + '\n\n---\n\n' + block + '\n', note: 'workflow block appended; existing content kept' };
}

function union(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

function mergeSettings(existing, template) {
  const out = { ...existing };
  if (!out.$schema && template.$schema) out.$schema = template.$schema;

  const perms = { ...(existing.permissions || {}) };
  for (const key of ['allow', 'deny', 'ask']) {
    if (!template.permissions || !template.permissions[key]) continue;
    let merged = union(perms[key], template.permissions[key]);
    // Old `Bash(x:*)` rules are dropped once the equivalent `Bash(x *)` is present.
    merged = merged.filter(rule => {
      const m = rule.match(/^(\w+)\((.*):\*\)$/);
      return !(m && merged.includes(`${m[1]}(${m[2]} *)`));
    });
    perms[key] = merged;
  }
  if (template.permissions) out.permissions = perms;

  const hooks = {};
  for (const [event, groups] of Object.entries(existing.hooks || {})) {
    const kept = groups
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !LEGACY_HOOK_PATTERNS.some(re => re.test(h.command || ''))) }))
      .filter(g => g.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(template.hooks || {})) {
    hooks[event] = hooks[event] || [];
    for (const group of groups) {
      const commands = group.hooks.map(h => h.command);
      const present = hooks[event].some(g => (g.hooks || []).some(h => commands.includes(h.command)));
      if (!present) hooks[event].push(group);
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;

  // Tool search is on by default now; the V5 opt-in is noise.
  if (out.env && out.env.ENABLE_TOOL_SEARCH === 'true') {
    const { ENABLE_TOOL_SEARCH, ...rest } = out.env;
    out.env = rest;
    if (!Object.keys(out.env).length) delete out.env;
  }
  return out;
}

// An existing .mcp.json is a curated choice (and may be gated by
// enabledMcpjsonServers), so template servers are only suggested, never added.
function suggestMcp(existing, template) {
  const have = existing.mcpServers || {};
  return Object.keys(template.mcpServers || {}).filter(name => !have[name]);
}

function mergeLines(existing, template) {
  const have = new Set(normalize(existing).split('\n').map(l => l.trim()));
  const missing = normalize(template).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !have.has(l));
  if (!missing.length) return null;
  return normalize(existing).trimEnd() + '\n\n# agentic-workflow-template\n' + missing.join('\n') + '\n';
}

// ═══ RUN ═══

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '').slice(0, 17); // 2026-09-25T141502
}

function install({ targetDir, tokens, mode, dryRun = false, skipDeps = false }) {
  const backupRoot = path.join(targetDir, '.claude', 'backups', timestamp());
  const actions = [];
  const record = (kind, rel, note) => actions.push({ kind, rel, note });

  const write = (rel, content) => {
    if (dryRun) return;
    const abs = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  const backup = rel => {
    if (dryRun) return;
    const dest = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(targetDir, rel), dest);
  };
  const readTarget = rel => {
    const abs = path.join(targetDir, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  };

  let depsChanged = false;

  for (const rel of walk(TEMPLATES_DIR)) {
    const rendered = render(fs.readFileSync(path.join(TEMPLATES_DIR, rel), 'utf8'), tokens);
    const existing = readTarget(rel);
    const kind = classify(rel);

    if (kind === 'seed') {
      if (existing === null) { write(rel, rendered); record('create', rel); }
      else record('keep', rel, 'yours — not touched');
      continue;
    }

    if (kind === 'managed') {
      if (existing === null) { write(rel, rendered); record('create', rel); }
      else if (normalize(existing) === normalize(rendered)) record('same', rel);
      else { backup(rel); write(rel, rendered); record('update', rel, 'previous version backed up'); }
      if (rel === 'tasks/package.json' && (existing === null || normalize(existing) !== normalize(rendered))) depsChanged = true;
      continue;
    }

    if (kind === 'claudeMd') {
      const { content, note } = mergeClaudeMd(existing, rendered);
      if (existing === null) { write(rel, content); record('create', rel); }
      else if (content === normalize(existing)) record('same', rel);
      else { backup(rel); write(rel, content); record('merge', rel, note); }
      continue;
    }

    if (kind === 'json') {
      const template = JSON.parse(rendered);
      if (existing === null) { write(rel, rendered); record('create', rel); continue; }
      let current;
      try { current = JSON.parse(existing); } catch (_) {
        record('skip', rel, 'existing file is not valid JSON — merge it by hand');
        continue;
      }
      if (rel === '.mcp.json') {
        const missing = suggestMcp(current, template);
        if (missing.length) record('keep', rel, 'yours — not touched; template also ships: ' + missing.join(', ') + ' (see templates/.mcp.json)');
        else record('same', rel);
        continue;
      }
      const merged = mergeSettings(current, template);
      const note = 'permissions/hooks merged, your entries kept';
      const text = JSON.stringify(merged, null, 2) + '\n';
      if (JSON.stringify(merged) === JSON.stringify(current)) record('same', rel);
      else { backup(rel); write(rel, text); record('merge', rel, note); }
      continue;
    }

    if (kind === 'lines') {
      if (existing === null) { write(rel, rendered); record('create', rel); continue; }
      const merged = mergeLines(existing, rendered);
      if (merged === null) record('same', rel);
      else { write(rel, merged); record('merge', rel, 'missing entries appended'); }
    }
  }

  for (const rel of DEPRECATED) {
    if (readTarget(rel) === null) continue;
    backup(rel);
    if (!dryRun) fs.unlinkSync(path.join(targetDir, rel));
    record('remove', rel, 'deprecated — backed up');
  }

  // Custom agents are never touched; point out how to wire one into reviews.
  const agentsDir = path.join(targetDir, '.claude', 'agents');
  const templateAgents = new Set(fs.readdirSync(path.join(TEMPLATES_DIR, '.claude', 'agents')));
  const deprecatedAgents = new Set(DEPRECATED.filter(d => d.startsWith('.claude/agents/')).map(d => path.basename(d)));
  const customAgents = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter(f => f.endsWith('.md') && !templateAgents.has(f) && !deprecatedAgents.has(f))
    : [];
  for (const f of customAgents) record('keep', '.claude/agents/' + f, 'custom agent — not touched');

  const prior = readManifest(targetDir);
  const manifest = {
    ...prior, // keeps project settings such as extraReviewers
    version: VERSION,
    installedAt: (prior && prior.installedAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tokens,
  };
  write(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  if (!dryRun) fs.mkdirSync(path.join(targetDir, '.claude', 'handoffs'), { recursive: true });

  report(actions, dryRun, backupRoot, targetDir);
  const wired = new Set(((prior && prior.extraReviewers) || []).map(r => r.agent));
  const unwired = customAgents.map(f => f.replace(/\.md$/, '')).filter(a => !wired.has(a));
  if (unwired.length) {
    log(`
  Custom agents kept: ${unwired.join(', ')}. To run one alongside the reviewer on every matching task, add to ${MANIFEST}:`, 'cyan');
    log(`    "extraReviewers": [{ "agent": "${unwired[0]}", "when": "pm" }]   (when: qa | security | pm | always)`, 'cyan');
  }
  if (dryRun) return actions;

  finalize(targetDir, { depsChanged, skipDeps });
  return actions;
}

function report(actions, dryRun, backupRoot, targetDir) {
  header(dryRun ? 'DRY RUN — NOTHING WRITTEN' : 'FILES');
  const icons = { create: ['+', 'green'], update: ['~', 'yellow'], merge: ['≈', 'yellow'], remove: ['-', 'red'], keep: ['=', 'dim'], same: ['=', 'dim'], skip: ['!', 'red'] };
  for (const a of actions) {
    if (a.kind === 'same') continue;
    const [icon, color] = icons[a.kind];
    log(`  ${icon} ${a.kind.padEnd(6)} ${a.rel}${a.note ? '  (' + a.note + ')' : ''}`, color);
  }
  const unchanged = actions.filter(a => a.kind === 'same').length;
  if (unchanged) log(`  = ${unchanged} file(s) already up to date`, 'dim');
  if (!dryRun && actions.some(a => ['update', 'merge', 'remove'].includes(a.kind) && !(a.rel === '.gitignore'))) {
    log(`\n  Backups: ${path.relative(targetDir, backupRoot)}`, 'cyan');
  }
}

function finalize(targetDir, { depsChanged, skipDeps }) {
  const tasksDir = path.join(targetDir, 'tasks');
  const run = (cmd, cwd, ok, fail) => {
    try {
      execSync(cmd, { cwd, stdio: 'pipe' });
      log('  ✓ ' + ok, 'green');
      return true;
    } catch (err) {
      log('  ⚠ ' + fail, 'yellow');
      return false;
    }
  };

  header('SETUP');
  const needInstall = depsChanged || !fs.existsSync(path.join(tasksDir, 'node_modules', 'sql.js'));
  if (skipDeps) log('  — skipped npm install (--skip-deps)', 'dim');
  else if (needInstall) run('npm install --no-audit --no-fund', tasksDir, 'task CLI dependencies installed', 'npm install failed — run it manually in tasks/');

  if (fs.existsSync(path.join(tasksDir, 'node_modules', 'sql.js'))) {
    run('node tasks/cli.js brief', targetDir, 'task database ready (schema migrated if it was older)', 'task database init failed — run: node tasks/cli.js brief');
    run('node tasks/cli.js context-digest', targetDir, 'context digest generated', 'digest skipped — fill in .claude/context/ then run: node tasks/cli.js context-digest');
  }
}

module.exports = {
  VERSION, MANIFEST, TEMPLATES_DIR,
  log, header,
  readManifest, isLegacyInstall, detectDefaults, tokensFromAnswers, extractLegacyTokens, deriveTestCommand,
  install,
  // exported for tests
  mergeClaudeMd, mergeSettings, suggestMcp, mergeLines,
};
