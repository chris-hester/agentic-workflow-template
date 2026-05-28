#!/usr/bin/env node

/**
 * V4 Upgrade Script
 * Safely upgrades existing projects using agentic-workflow-template to V4.
 *
 * Key behaviors:
 * - Detects existing project by checking for CLAUDE.md + .claude/agents/ + tasks/cli.js
 * - Extracts project tokens from existing files (no re-asking the 10 questions)
 * - Backs up every file it modifies (.backup-YYYY-MM-DD)
 * - Replaces template-owned code (db.js, cli.js, agent files, ORCHESTRATION.md)
 * - Preserves user-owned content (context files untouched, CLAUDE.md Key Decisions + Dev Notes re-injected)
 * - Runs database migration (additive only)
 * - Creates new files (decomposer.md, migration script)
 * - Deletes deprecated files (context-manifest.json, with backup)
 * - Generates context digest
 * - Creates .claude/handoffs/ directory
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(message, 'bright');
  log('='.repeat(60), 'cyan');
}

const TODAY = new Date().toISOString().split('T')[0];

function backup(filePath) {
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + '.backup-' + TODAY;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }
  return null;
}

function detectProject(targetDir) {
  const claudeMd = path.join(targetDir, 'CLAUDE.md');
  const agentsDir = path.join(targetDir, '.claude', 'agents');
  const cliJs = path.join(targetDir, 'tasks', 'cli.js');

  if (!fs.existsSync(claudeMd)) return false;
  if (!fs.existsSync(agentsDir)) return false;
  if (!fs.existsSync(cliJs)) return false;
  return true;
}

function extractTokens(targetDir) {
  const tokens = {};

  // Extract from CLAUDE.md
  const claudePath = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) {
    const content = fs.readFileSync(claudePath, 'utf8');

    // PROJECT_NAME: from heading
    const nameMatch = content.match(/^#\s+(.+?)\s*[-–—]/m);
    if (nameMatch) tokens.PROJECT_NAME = nameMatch[1].trim();

    // TECH_STACK: from Tech Stack line
    const stackMatch = content.match(/\*\*Tech Stack:\*\*\s*(.+)/);
    if (stackMatch) tokens.TECH_STACK = stackMatch[1].trim();
  }

  // Extract from project-overview.md
  const overviewPath = path.join(targetDir, '.claude', 'context', 'project-overview.md');
  if (fs.existsSync(overviewPath)) {
    const content = fs.readFileSync(overviewPath, 'utf8');

    const descMatch = content.match(/##\s*Project Description\s*\n+([\s\S]+?)(?=\n##|\n---|\z)/);
    if (descMatch) tokens.PROJECT_DESCRIPTION = descMatch[1].trim().split('\n')[0];

    const frameworkMatch = content.match(/\*\*Framework:\*\*\s*(.+)/);
    if (frameworkMatch) tokens.FRAMEWORK = frameworkMatch[1].trim();

    const stylingMatch = content.match(/\*\*Styling:\*\*\s*(.+)/);
    if (stylingMatch) tokens.STYLING = stylingMatch[1].trim();

    const cmsMatch = content.match(/\*\*CMS\/Backend:\*\*\s*(.+)/);
    if (cmsMatch) tokens.CMS = cmsMatch[1].trim();

    const hostingMatch = content.match(/\*\*Hosting:\*\*\s*(.+)/);
    if (hostingMatch) tokens.HOSTING = hostingMatch[1].trim();
  }

  // Extract from design-system.md
  const designPath = path.join(targetDir, '.claude', 'context', 'design-system.md');
  if (fs.existsSync(designPath)) {
    const content = fs.readFileSync(designPath, 'utf8');

    const colorsMatch = content.match(/\*\*Brand Colors:\*\*\s*(.+)/);
    if (colorsMatch) tokens.BRAND_COLORS = colorsMatch[1].trim();

    const fontsMatch = content.match(/\*\*Fonts:\*\*\s*(.+)/);
    if (fontsMatch) tokens.FONTS = fontsMatch[1].trim();
  }

  // Extract from requirements-summary.md
  const reqPath = path.join(targetDir, '.claude', 'context', 'requirements-summary.md');
  if (fs.existsSync(reqPath)) {
    const content = fs.readFileSync(reqPath, 'utf8');

    const secMatch = content.match(/\{\{SECURITY_KEYWORDS\}\}|Security Keywords[:\s]+(.+)/);
    if (secMatch && secMatch[1]) tokens.SECURITY_KEYWORDS = secMatch[1].trim();
  }

  // Extract testing from existing cli agent or ORCHESTRATION
  const orchPath = path.join(targetDir, '.claude', 'ORCHESTRATION.md');
  if (fs.existsSync(orchPath)) {
    const content = fs.readFileSync(orchPath, 'utf8');
    const testingMatch = content.match(/npx\s+(\S+)\s+run/);
    if (testingMatch) tokens.TESTING = testingMatch[1].trim();
  }

  // Defaults for anything missing
  if (!tokens.PROJECT_NAME) tokens.PROJECT_NAME = path.basename(targetDir);
  if (!tokens.PROJECT_DESCRIPTION) tokens.PROJECT_DESCRIPTION = 'Project description';
  if (!tokens.TECH_STACK) tokens.TECH_STACK = 'See project-overview.md';
  if (!tokens.FRAMEWORK) tokens.FRAMEWORK = 'See project-overview.md';
  if (!tokens.STYLING) tokens.STYLING = 'See design-system.md';
  if (!tokens.CMS) tokens.CMS = 'none';
  if (!tokens.HOSTING) tokens.HOSTING = 'See project-overview.md';
  if (!tokens.TESTING) tokens.TESTING = 'vitest';
  if (!tokens.BRAND_COLORS) tokens.BRAND_COLORS = 'TBD — fill in .claude/context/design-system.md';
  if (!tokens.FONTS) tokens.FONTS = 'TBD — fill in .claude/context/design-system.md';
  if (!tokens.SECURITY_KEYWORDS) {
    const cmsName = tokens.CMS.toLowerCase() === 'none' ? '' : tokens.CMS;
    const base = 'API, form, fetch, POST, env, .env, token, auth, secret, cookie, session, input, validation, CSRF, XSS, redirect, sanitize';
    tokens.SECURITY_KEYWORDS = cmsName ? `${base}, ${cmsName}` : base;
  }

  return tokens;
}

function extractUserSections(claudeMdContent) {
  const sections = {};

  // Extract Key Decisions table rows (user-added rows only, skip header and placeholder)
  const decisionsMatch = claudeMdContent.match(/## Key Decisions\s*\n[\s\S]*?\n(\|[\s\S]*?)(?=\n##|\n---|\z)/);
  if (decisionsMatch) {
    sections.keyDecisions = decisionsMatch[0];
  }

  // Extract Development Notes section
  const notesMatch = claudeMdContent.match(/## Development Notes\s*\n([\s\S]*)$/);
  if (notesMatch) {
    sections.devNotes = notesMatch[1].trim();
  }

  return sections;
}

function replaceTokens(content, tokens) {
  let result = content;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.split('{{' + token + '}}').join(value);
  }
  return result;
}

async function main() {
  const targetDir = process.cwd();

  header('AGENTIC WORKFLOW TEMPLATE — V4 UPGRADE');
  log(`Target project: ${targetDir}`, 'cyan');

  // Detect project
  if (!detectProject(targetDir)) {
    log('\n❌ ERROR: This does not appear to be an agentic-workflow-template project.', 'red');
    log('Expected: CLAUDE.md + .claude/agents/ + tasks/cli.js', 'yellow');
    process.exit(1);
  }
  log('✓ Project detected', 'green');

  // Extract tokens
  header('EXTRACTING PROJECT TOKENS');
  const tokens = extractTokens(targetDir);
  log(`  PROJECT_NAME: ${tokens.PROJECT_NAME}`, 'cyan');
  log(`  TECH_STACK: ${tokens.TECH_STACK}`, 'cyan');
  log(`  TESTING: ${tokens.TESTING}`, 'cyan');

  // Extract user content from existing CLAUDE.md before replacing
  header('PRESERVING USER CONTENT');
  const claudePath = path.join(targetDir, 'CLAUDE.md');
  const existingClaude = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
  const userSections = extractUserSections(existingClaude);
  log('✓ Key Decisions and Development Notes preserved', 'green');

  // Locate template source directory
  const scriptDir = __dirname;
  const templatesDir = path.join(scriptDir, 'templates');
  if (!fs.existsSync(templatesDir)) {
    log('\n❌ ERROR: templates/ directory not found at: ' + templatesDir, 'red');
    process.exit(1);
  }

  // Files to replace (template-owned)
  const templateFiles = [
    { src: 'CLAUDE.md', dest: 'CLAUDE.md' },
    { src: '.claude/ORCHESTRATION.md', dest: '.claude/ORCHESTRATION.md' },
    { src: '.claude/agents/developer.md', dest: '.claude/agents/developer.md' },
    { src: '.claude/agents/reviewer.md', dest: '.claude/agents/reviewer.md' },
    { src: '.claude/agents/researcher.md', dest: '.claude/agents/researcher.md' },
    { src: 'tasks/db.js', dest: 'tasks/db.js' },
    { src: 'tasks/cli.js', dest: 'tasks/cli.js' },
  ];

  // New files to create
  const newFiles = [
    { src: '.claude/agents/decomposer.md', dest: '.claude/agents/decomposer.md' },
    { src: 'tasks/migrate-v4-artifacts.js', dest: 'tasks/migrate-v4-artifacts.js' },
    { src: '.gitignore', dest: '.gitignore' },
  ];

  header('REPLACING TEMPLATE FILES');

  for (const { src, dest } of templateFiles) {
    const srcPath = path.join(templatesDir, src);
    const destPath = path.join(targetDir, dest);

    if (!fs.existsSync(srcPath)) {
      log(`  ⚠ Source not found: ${src} — skipping`, 'yellow');
      continue;
    }

    // Backup existing file
    const backupPath = backup(destPath);
    if (backupPath) {
      log(`  ↩ Backed up: ${dest} → ${path.basename(backupPath)}`, 'yellow');
    }

    // Process and write
    let content = fs.readFileSync(srcPath, 'utf8');
    content = replaceTokens(content, tokens);

    // For CLAUDE.md: re-inject user sections
    if (dest === 'CLAUDE.md') {
      if (userSections.keyDecisions) {
        content = content.replace(
          /## Key Decisions\s*\n[\s\S]*?(?=\n##|\n---|\z)/,
          userSections.keyDecisions + '\n\n'
        );
      }
      if (userSections.devNotes) {
        content = content.replace(
          /## Development Notes\s*\n<!-- Add project-specific notes[\s\S]*?-->/,
          '## Development Notes\n\n' + userSections.devNotes
        );
      }
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf8');
    log(`  ✓ Updated: ${dest}`, 'green');
  }

  header('CREATING NEW FILES');

  for (const { src, dest } of newFiles) {
    const srcPath = path.join(templatesDir, src);
    const destPath = path.join(targetDir, dest);

    if (!fs.existsSync(srcPath)) {
      log(`  ⚠ Source not found: ${src} — skipping`, 'yellow');
      continue;
    }

    // Backup if it exists
    if (fs.existsSync(destPath)) {
      const backupPath = backup(destPath);
      log(`  ↩ Backed up existing: ${dest}`, 'yellow');
    }

    let content = fs.readFileSync(srcPath, 'utf8');
    content = replaceTokens(content, tokens);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content, 'utf8');
    log(`  ✓ Created: ${dest}`, 'green');
  }

  // Delete deprecated files (with backup)
  header('REMOVING DEPRECATED FILES');

  const deprecated = [
    '.claude/context/context-manifest.json',
    '.claude/agents/qa-reviewer.md',
    '.claude/agents/security-ops.md',
    '.claude/agents/project-manager.md',
    '.claude/agents/task-manager.md',
  ];

  for (const rel of deprecated) {
    const filePath = path.join(targetDir, rel);
    if (fs.existsSync(filePath)) {
      const backupPath = backup(filePath);
      fs.unlinkSync(filePath);
      log(`  ✓ Deleted: ${rel} (backed up as ${path.basename(backupPath)})`, 'green');
    } else {
      log(`  — Already absent: ${rel}`, 'yellow');
    }
  }

  // Create handoffs directory
  const handoffsDir = path.join(targetDir, '.claude', 'handoffs');
  if (!fs.existsSync(handoffsDir)) {
    fs.mkdirSync(handoffsDir, { recursive: true });
    log('  ✓ Created .claude/handoffs/ directory', 'green');
  }

  // Run database migration
  header('RUNNING DATABASE MIGRATION');

  const migrateScript = path.join(targetDir, 'tasks', 'migrate-v4-artifacts.js');
  if (fs.existsSync(migrateScript)) {
    try {
      execSync('node tasks/migrate-v4-artifacts.js', { cwd: targetDir, stdio: 'pipe' });
      log('✓ Database migration complete', 'green');
    } catch (error) {
      log('⚠ Migration failed. Run manually: node tasks/migrate-v4-artifacts.js', 'yellow');
      log('  ' + error.message, 'yellow');
    }
  }

  // Generate context digest
  header('GENERATING CONTEXT DIGEST');

  try {
    execSync('node tasks/cli.js context-digest', { cwd: targetDir, stdio: 'pipe' });
    log('✓ Context digest generated: .claude/context/DIGEST.md', 'green');
  } catch (error) {
    log('⚠ Digest generation skipped (fill in context files first)', 'yellow');
  }

  header('UPGRADE COMPLETE!');

  log('\n✅ Your project has been upgraded to V4.\n', 'green');
  log('What changed:', 'bright');
  log('  - CLAUDE.md slimmed to ~4 KB (loaded every turn)', 'cyan');
  log('  - ORCHESTRATION.md rewritten with circuit breaker, dry run, session summary', 'cyan');
  log('  - CLI claim now outputs model/reviews/context automatically', 'cyan');
  log('  - Artifact storage added (cross-agent report passing)', 'cyan');
  log('  - Auto-unblock of dependent tasks on completion', 'cyan');
  log('  - New decomposer agent available', 'cyan');
  log('  - context-manifest.json removed (deprecated)', 'cyan');
  log('\nYour data:', 'bright');
  log('  - Task database preserved (migration was additive only)', 'green');
  log('  - Context files untouched', 'green');
  log('  - Key Decisions and Dev Notes preserved in CLAUDE.md', 'green');
  log('  - All modified files backed up as *.backup-' + TODAY, 'green');
  log('\nNext step:', 'bright');
  log('  Tell Claude: "work on task X" — the workflow has been upgraded.\n', 'cyan');
}

main().catch(err => {
  console.error('\n❌ Upgrade failed:', err.message);
  process.exit(1);
});
