const fs = require('fs');
const path = require('path');
const readline = require('readline');
const installer = require('./installer');

const { log, header } = installer;

const USAGE = `
Usage: node <template>/bootstrap.js [options]      (run from your project root)

  --target <dir>   Project to install into (default: current directory)
  --dry-run        Show what would be created/updated/merged; write nothing
  --yes            Non-interactive: accept the defaults detected from package.json
  --upgrade        Require an existing install and upgrade it (auto-detected anyway)
  --skip-deps      Don't run npm install in tasks/
`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'target') flags.target = argv[++i];
    else flags[key] = true;
  }
  return flags;
}

async function ask(questions, defaults, interactive) {
  const answers = {};
  if (!interactive) {
    for (const [key] of questions) answers[key] = defaults[key] || '';
    return answers;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = text => new Promise(resolve => rl.question(text, resolve));
  for (const [key, label] of questions) {
    const def = defaults[key] || '';
    const hint = def ? ` [${def}]` : '';
    const reply = (await q(`\x1b[34m${label}${hint}:\x1b[0m `)).trim();
    answers[key] = reply || def;
  }
  rl.close();
  return answers;
}

const QUESTIONS = [
  ['projectName', ' 1. Project name'],
  ['description', ' 2. Short description (one line)'],
  ['techStack', ' 3. Tech stack summary (e.g. "Next.js 15 + TypeScript + Tailwind CSS")'],
  ['framework', ' 4. Primary framework'],
  ['styling', ' 5. Styling approach, or "none"'],
  ['cms', ' 6. CMS/backend, or "none"'],
  ['hosting', ' 7. Hosting target'],
  ['testing', ' 8. Testing framework (Vitest, Jest, Playwright…) or "none"'],
  ['brandColors', ' 9. Brand colors (hex, comma-separated) or "skip"'],
  ['fonts', '10. Fonts ("headings: X, body: Y") or "skip"'],
];

async function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) { console.log(USAGE); return; }

  const targetDir = path.resolve(flags.target || process.cwd());
  if (path.resolve(targetDir) === path.resolve(__dirname, '..')) {
    log('Run this from your project directory (or pass --target), not from the template repo.', 'red');
    process.exit(1);
  }
  if (!fs.existsSync(targetDir)) {
    log(`Target directory does not exist: ${targetDir}`, 'red');
    process.exit(1);
  }

  const manifest = installer.readManifest(targetDir);
  const legacy = !manifest && installer.isLegacyInstall(targetDir);
  const installed = Boolean(manifest) || legacy;
  const dryRun = Boolean(flags['dry-run']);

  if (flags.upgrade && !installed) {
    log('No existing agentic-workflow install found here (no .claude/agentic-workflow.json, and no CLAUDE.md + .claude/agents + tasks/cli.js).', 'red');
    log('Run bootstrap.js without --upgrade to install into this project.', 'yellow');
    process.exit(1);
  }

  let tokens;
  if (installed) {
    const from = manifest ? `v${manifest.version}` : 'a pre-V6 install';
    header(`AGENTIC WORKFLOW — UPGRADE ${from} → v${installer.VERSION}`);
    log(`Target: ${targetDir}`, 'cyan');
    // Manifest answers win; anything missing (new tokens) is recovered or defaulted.
    tokens = { ...installer.extractLegacyTokens(targetDir), ...(manifest && manifest.tokens) };
    if (!tokens.TEST_COMMAND) tokens.TEST_COMMAND = installer.deriveTestCommand(tokens.TESTING, targetDir);
    log(`Project: ${tokens.PROJECT_NAME} | Tests: ${tokens.TEST_COMMAND}`, 'cyan');
  } else {
    header(`AGENTIC WORKFLOW — INSTALL v${installer.VERSION}`);
    log(`Target: ${targetDir}`, 'cyan');
    const existingCode = fs.existsSync(path.join(targetDir, 'package.json')) || fs.existsSync(path.join(targetDir, 'CLAUDE.md'));
    if (existingCode) {
      log('Existing project detected — your files are merged, not overwritten (backups go to .claude/backups/).', 'cyan');
    }
    const interactive = !flags.yes && process.stdin.isTTY;
    if (!flags.yes && !process.stdin.isTTY) log('No TTY — using detected defaults (same as --yes).', 'yellow');
    if (interactive) log('Press Enter to accept a [default].\n', 'dim');
    const answers = await ask(QUESTIONS, installer.detectDefaults(targetDir), interactive);
    tokens = installer.tokensFromAnswers(answers, targetDir);
  }

  installer.install({ targetDir, tokens, mode: installed ? 'upgrade' : 'install', dryRun, skipDeps: Boolean(flags['skip-deps']) });

  if (dryRun) {
    log('\nRe-run without --dry-run to apply.\n', 'cyan');
    return;
  }

  header(installed ? 'UPGRADE COMPLETE' : 'INSTALL COMPLETE');
  if (!installed) {
    log('\nNext steps:', 'bright');
    log('  1. Fill in .claude/context/project-overview.md, design-system.md, requirements-summary.md');
    log('     then: node tasks/cli.js context-digest');
    log('  2. In Claude Code: /decompose <your goal>   (or add tasks with node tasks/cli.js add ...)');
    log('  3. /work-task next');
  } else {
    log('\nIn Claude Code: /work-task <id> now runs the task-pipeline workflow.', 'cyan');
    log('Review the backups in .claude/backups/ and delete them once you are happy.', 'cyan');
  }
  log('\nRestart any running Claude Code session in this project so it picks up the new agents, skills and hooks.\n', 'yellow');
}

module.exports = { main };
