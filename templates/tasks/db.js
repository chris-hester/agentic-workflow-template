const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'tasks.db');
const LOCK_PATH = DB_PATH + '.lock';
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 15000;

let db = null;
let lockHeld = false;

// ═══ LOCKING ═══
// sql.js loads the whole DB into memory and writes the whole file back, so two
// CLI processes running at once (parallel subagents) would silently drop each
// other's writes. Every process holds an exclusive lock file from first DB
// access until close().

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  if (lockHeld) return;
  const start = Date.now();
  while (true) {
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
      lockHeld = true;
      process.once('exit', releaseLock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch (_) {
        continue; // lock vanished between checks — retry immediately
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error('Task DB is locked (' + LOCK_PATH + '). If no other task CLI is running, delete the lock file.');
      }
      sleepSync(50);
    }
  }
}

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}

async function getDb() {
  if (db) return db;

  acquireLock();
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    if (migrateSchema(db)) saveDb(db);
  } else {
    db = new SQL.Database();
    initializeSchema(db);
  }

  return db;
}

// Columns added after the original release. Databases created by any earlier
// template version get these on first open, so no separate migration step.
const ADDED_TASK_COLUMNS = {
  claimed_by_session: 'TEXT',
  model: 'TEXT',
  effort: 'TEXT',
  reviews: 'TEXT',
  parent_task_id: 'INTEGER',
  iteration: 'INTEGER DEFAULT 1',
};

function migrateSchema(database) {
  const tableCount = () => database.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'")[0].values[0][0];
  const before = tableCount();
  createTables(database);
  let changed = tableCount() !== before;

  const info = database.exec('PRAGMA table_info(tasks)');
  const existing = info[0] ? info[0].values.map(row => row[1]) : [];
  for (const [col, type] of Object.entries(ADDED_TASK_COLUMNS)) {
    if (!existing.includes(col)) {
      database.run(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
      changed = true;
    }
  }

  createIndexes(database);
  return changed;
}

function initializeSchema(database) {
  createTables(database);
  createIndexes(database);
  saveDb(database);
}

function createIndexes(database) {
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(claimed_by_session)
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id, artifact_type)
  `);
}

function createTables(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      priority TEXT CHECK(priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
      status TEXT DEFAULT 'ready' CHECK(status IN ('ready','in_progress','blocked','completed')),
      group_name TEXT,
      category TEXT,
      description TEXT,
      fix_required TEXT,
      files_affected TEXT,
      tests TEXT,
      blocked_by TEXT,
      claimed_by TEXT,
      claimed_by_session TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      completed_by TEXT,
      completion_summary TEXT,
      model TEXT,
      effort TEXT,
      reviews TEXT,
      parent_task_id INTEGER,
      iteration INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now')),
      current_task_id INTEGER,
      agent_type TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','stale'))
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      action TEXT,
      agent TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      tool_uses INTEGER,
      duration_seconds INTEGER
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS task_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      agent TEXT,
      content TEXT,
      iteration INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS review_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      dimension TEXT,
      checklist_item TEXT,
      result TEXT,
      was_useful INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function saveDb(database) {
  const d = database || db;
  if (!d) return;
  const data = d.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Task CRUD Operations
async function addTask({ title, priority = 'MEDIUM', group_name, category, description, files_affected, tests, blocked_by, model, effort, reviews, parent_task_id, iteration }) {
  const database = await getDb();
  // model stays NULL unless given explicitly, so claim-time inference can tell
  // "never routed" apart from "pinned by the user".
  if (model && !effort) effort = 'default';
  blocked_by = await openDependencies(blocked_by);
  const status = blocked_by ? 'blocked' : 'ready';
  database.run(
    `INSERT INTO tasks (title, priority, status, group_name, category, description, files_affected, tests, blocked_by, model, effort, reviews, parent_task_id, iteration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, priority, status, group_name || null, category || null, description || null, files_affected || null, tests || null, blocked_by, model || null, effort || null, reviews || null, parent_task_id || null, iteration || null]
  );
  // Read the id before saving: sql.js export() reopens the DB, which resets
  // last_insert_rowid() to 0.
  const id = database.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  saveDb(database);
  return id;
}

// Drops dependencies that are already completed; returns null when none remain.
async function openDependencies(blockedBy) {
  const ids = (blockedBy || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
  const open = [];
  for (const id of ids) {
    const dep = await getTask(id);
    if (!dep || dep.status !== 'completed') open.push(id);
  }
  return open.length ? open.join(',') : null;
}

async function getTask(id) {
  const database = await getDb();
  const result = database.exec(`SELECT * FROM tasks WHERE id = ?`, [id]);
  if (!result.length || !result[0].values.length) return null;
  const columns = result[0].columns;
  const values = result[0].values[0];
  const task = {};
  columns.forEach((col, i) => { task[col] = values[i]; });
  return task;
}

async function listTasks(filters = {}) {
  const database = await getDb();
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.priority) {
    query += ' AND priority = ?';
    params.push(filters.priority);
  }
  if (filters.group_name) {
    query += ' AND group_name = ?';
    params.push(filters.group_name);
  }
  if (filters.category) {
    query += ' AND category = ?';
    params.push(filters.category);
  }
  if (filters.claimed_by) {
    query += ' AND claimed_by = ?';
    params.push(filters.claimed_by);
  }
  if (filters.claimed_by_session) {
    query += ' AND claimed_by_session = ?';
    params.push(filters.claimed_by_session);
  }

  query += ' ORDER BY CASE priority WHEN \'CRITICAL\' THEN 1 WHEN \'HIGH\' THEN 2 WHEN \'MEDIUM\' THEN 3 WHEN \'LOW\' THEN 4 END, id';

  const result = database.exec(query, params);
  if (!result.length) return [];

  const columns = result[0].columns;
  return result[0].values.map(row => {
    const task = {};
    columns.forEach((col, i) => { task[col] = row[i]; });
    return task;
  });
}

async function updateTask(id, updates) {
  const database = await getDb();
  const fields = Object.keys(updates).filter(k => updates[k] !== undefined);
  if (!fields.length) return;

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  values.push(id);

  database.run(`UPDATE tasks SET ${setClause}, updated_at = datetime('now') WHERE id = ?`, values);
  saveDb(database);

  // Log history
  for (const field of fields) {
    await addHistory(id, `update_${field}`, null, null, updates[field]);
  }
}

async function claimTask(id, agent, sessionId = null) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  if (task.status === 'completed') throw new Error(`Task ${id} already completed`);

  // Check if already claimed by different agent or session
  if (task.claimed_by && task.claimed_by !== agent) {
    throw new Error(`Task ${id} already claimed by ${task.claimed_by}`);
  }
  if (sessionId && task.claimed_by_session && task.claimed_by_session !== sessionId) {
    throw new Error(`Task ${id} already claimed by session ${task.claimed_by_session}`);
  }

  await updateTask(id, {
    status: 'in_progress',
    claimed_by: agent,
    claimed_by_session: sessionId,
    claimed_at: new Date().toISOString()
  });

  const historyNote = sessionId ? `${agent} (session: ${sessionId})` : agent;
  await addHistory(id, 'claim', historyNote, task.status, 'in_progress');
}

async function releaseTask(id) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);

  const historyNote = task.claimed_by_session
    ? `${task.claimed_by} (session: ${task.claimed_by_session})`
    : task.claimed_by;

  await updateTask(id, {
    status: 'ready',
    claimed_by: null,
    claimed_by_session: null,
    claimed_at: null
  });
  await addHistory(id, 'release', historyNote, 'in_progress', 'ready');
}

async function completeTask(id, summary, agent) {
  const task = await getTask(id);
  if (!task) throw new Error('Task ' + id + ' not found');
  await updateTask(id, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_by: agent || task.claimed_by,
    completion_summary: summary
  });
  await addHistory(id, 'complete', agent || task.claimed_by, task.status, 'completed');
  const unblocked = await autoUnblockDependents(id);
  return { unblocked };
}

async function blockTask(id, reason) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);

  await updateTask(id, {
    status: 'blocked',
    fix_required: reason
  });
  await addHistory(id, 'block', null, task.status, 'blocked');
}

async function unblockTask(id) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);

  await updateTask(id, {
    status: 'ready',
    fix_required: null
  });
  await addHistory(id, 'unblock', null, 'blocked', 'ready');
}

// History
async function addHistory(taskId, action, agent, oldValue, newValue) {
  const database = await getDb();
  database.run(
    `INSERT INTO task_history (task_id, action, agent, old_value, new_value)
     VALUES (?, ?, ?, ?, ?)`,
    [taskId, action, agent || null, oldValue || null, newValue || null]
  );
  saveDb(database);
}

async function getHistory(taskId) {
  const database = await getDb();
  const result = database.exec(
    `SELECT * FROM task_history WHERE task_id = ? ORDER BY timestamp DESC`,
    [taskId]
  );
  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const entry = {};
    columns.forEach((col, i) => { entry[col] = row[i]; });
    return entry;
  });
}

// Sessions
async function startSession(sessionId, agentType) {
  const database = await getDb();
  database.run(
    `INSERT OR REPLACE INTO sessions (session_id, agent_type, status)
     VALUES (?, ?, 'active')`,
    [sessionId, agentType || 'primary']
  );
  saveDb(database);
}

async function endSession(sessionId) {
  const database = await getDb();
  database.run(
    `UPDATE sessions SET status = 'completed', last_active = datetime('now') WHERE session_id = ?`,
    [sessionId]
  );
  saveDb(database);
}

async function getActiveSessions() {
  const database = await getDb();
  const result = database.exec(`
    SELECT
      s.*,
      COUNT(t.id) as task_count
    FROM sessions s
    LEFT JOIN tasks t ON t.claimed_by_session = s.session_id AND t.status = 'in_progress'
    WHERE s.status = 'active'
    GROUP BY s.session_id
  `);
  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const session = {};
    columns.forEach((col, i) => { session[col] = row[i]; });
    return session;
  });
}

async function getTasksBySession(sessionId) {
  const database = await getDb();
  const result = database.exec(
    `SELECT * FROM tasks WHERE claimed_by_session = ? ORDER BY
     CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 END, id`,
    [sessionId]
  );
  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const task = {};
    columns.forEach((col, i) => { task[col] = row[i]; });
    return task;
  });
}

async function assignTaskToSession(taskId, sessionId, agent = 'developer') {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Check for file conflicts with other tasks in this session
  const sessionTasks = await getTasksBySession(sessionId);
  const taskFiles = (task.files_affected || '').split(',').map(f => f.trim()).filter(Boolean);

  for (const otherTask of sessionTasks) {
    if (otherTask.id === taskId) continue;
    const otherFiles = (otherTask.files_affected || '').split(',').map(f => f.trim()).filter(Boolean);
    const conflicts = taskFiles.filter(f => otherFiles.includes(f));
    if (conflicts.length > 0) {
      throw new Error(
        `Task ${taskId} conflicts with task ${otherTask.id} in session ${sessionId} (files: ${conflicts.join(', ')})`
      );
    }
  }

  // Assign task to session
  await claimTask(taskId, agent, sessionId);
}

// Statistics
async function getStats() {
  const database = await getDb();
  const result = database.exec(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM tasks
  `);

  if (!result.length || !result[0].values.length) {
    return { total: 0, ready: 0, in_progress: 0, blocked: 0, completed: 0, completion_pct: 0 };
  }

  const values = result[0].values[0];
  const total = values[0] || 0;
  const completed = values[4] || 0;

  return {
    total,
    ready: values[1] || 0,
    in_progress: values[2] || 0,
    blocked: values[3] || 0,
    completed,
    completion_pct: total > 0 ? Math.round((completed / total) * 100) : 0
  };
}

async function getAgentStats() {
  const database = await getDb();
  const result = database.exec(`
    SELECT
      agent,
      COUNT(*) as actions,
      SUM(CASE WHEN action = 'complete' THEN 1 ELSE 0 END) as completions,
      SUM(CASE WHEN action = 'claim' THEN 1 ELSE 0 END) as claims
    FROM task_history
    WHERE agent IS NOT NULL
    GROUP BY agent
    ORDER BY completions DESC
  `);

  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const stat = {};
    columns.forEach((col, i) => { stat[col] = row[i]; });
    return stat;
  });
}

async function getStaleTasks(hours = 24) {
  const database = await getDb();
  const result = database.exec(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
    AND claimed_at < datetime('now', '-${hours} hours')
    ORDER BY claimed_at ASC
  `);

  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const task = {};
    columns.forEach((col, i) => { task[col] = row[i]; });
    return task;
  });
}

async function getNextTask() {
  const database = await getDb();
  const result = database.exec(`
    SELECT * FROM tasks
    WHERE status = 'ready'
    AND (blocked_by IS NULL OR blocked_by = '')
    ORDER BY
      CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 END,
      id
    LIMIT 1
  `);

  if (!result.length || !result[0].values.length) return null;
  const columns = result[0].columns;
  const values = result[0].values[0];
  const task = {};
  columns.forEach((col, i) => { task[col] = values[i]; });
  return task;
}

async function conflictCheck(taskIds) {
  const tasks = [];
  for (const id of taskIds) {
    const task = await getTask(id);
    if (task) tasks.push(task);
  }

  const conflicts = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const filesA = (tasks[i].files_affected || '').split(',').map(f => f.trim()).filter(Boolean);
      const filesB = (tasks[j].files_affected || '').split(',').map(f => f.trim()).filter(Boolean);
      const overlap = filesA.filter(f => filesB.includes(f));
      if (overlap.length > 0) {
        conflicts.push({
          task_a: tasks[i].id,
          task_b: tasks[j].id,
          conflicting_files: overlap
        });
      }
    }
  }

  return conflicts;
}

async function suggestBatch(sessionCount = 2, autoAssign = false, agent = 'developer') {
  const tasks = await listTasks({ status: 'ready' });
  const batches = [];

  // Simple grouping: assign tasks to sessions round-robin, avoiding file conflicts
  const sessions = Array.from({ length: sessionCount }, () => []);
  const assignedFiles = Array.from({ length: sessionCount }, () => new Set());

  for (const task of tasks) {
    const taskFiles = (task.files_affected || '').split(',').map(f => f.trim()).filter(Boolean);

    // Find session with least file conflicts
    let bestSession = 0;
    let leastConflicts = Infinity;

    for (let s = 0; s < sessionCount; s++) {
      const conflicts = taskFiles.filter(f => assignedFiles[s].has(f)).length;
      if (conflicts < leastConflicts) {
        leastConflicts = conflicts;
        bestSession = s;
      }
    }

    sessions[bestSession].push(task);
    taskFiles.forEach(f => assignedFiles[bestSession].add(f));
  }

  const results = sessions.map((tasks, i) => ({
    session: `session-${i + 1}`,
    tasks: tasks.map(t => ({ id: t.id, title: t.title, priority: t.priority }))
  }));

  // If autoAssign is enabled, actually claim the tasks for the sessions
  if (autoAssign) {
    for (const batch of results) {
      for (const task of batch.tasks) {
        try {
          await claimTask(task.id, agent, batch.session);
        } catch (error) {
          console.warn(`Warning: Could not assign task ${task.id} to ${batch.session}: ${error.message}`);
        }
      }
    }
  }

  return results;
}

async function getDependencyTree(taskId, depth = 0, visited = new Set()) {
  if (visited.has(taskId)) return { id: taskId, title: '(circular)', children: [] };
  visited.add(taskId);

  const task = await getTask(taskId);
  if (!task) return null;

  const tree = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    depth,
    children: []
  };

  // Find tasks blocked by this one
  const allTasks = await listTasks({});
  for (const t of allTasks) {
    const blockedBy = (t.blocked_by || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    if (blockedBy.includes(taskId)) {
      const child = await getDependencyTree(t.id, depth + 1, visited);
      if (child) tree.children.push(child);
    }
  }

  return tree;
}

async function exportTasks(format = 'json') {
  const tasks = await listTasks({});
  const stats = await getStats();

  if (format === 'json') {
    return JSON.stringify({ tasks, stats, exported_at: new Date().toISOString() }, null, 2);
  }

  // Markdown format
  let md = '# Tasks Export\n\n';
  md += `**Exported:** ${new Date().toISOString()}\n`;
  md += `**Total:** ${stats.total} | **Completed:** ${stats.completed} (${stats.completion_pct}%)\n\n`;

  const groups = {};
  for (const task of tasks) {
    const group = task.group_name || 'Ungrouped';
    if (!groups[group]) groups[group] = [];
    groups[group].push(task);
  }

  for (const [group, tasks] of Object.entries(groups)) {
    md += `## Group ${group}\n\n`;
    for (const task of tasks) {
      const check = task.status === 'completed' ? 'x' : ' ';
      md += `- [${check}] **#${task.id}** ${task.title} (${task.priority}) [${task.status}]\n`;
      if (task.description) md += `  ${task.description}\n`;
    }
    md += '\n';
  }

  return md;
}

// ═══ AUTO-INFERENCE ═══

const SECURITY_KEYWORDS = '{{SECURITY_KEYWORDS}}'.split(',').map(s => s.trim().toLowerCase());
const UX_KEYWORDS = ['page', 'component', 'section', 'layout', 'design', 'content', 'navigation', 'ux'];

// Fix rounds allowed before a task is blocked. The last round escalates.
const MAX_FIX_ITERATIONS = 3;

function countFiles(task) {
  return (task.files_affected || '').split(',').filter(s => s.trim()).length;
}

// Returns { model, effort }. effort 'default' means "don't pass one" (Haiku).
function inferRouting(task) {
  const filesCount = countFiles(task);
  const descLen = (task.description || '').length;
  if (task.priority === 'CRITICAL') return { model: 'opus', effort: 'xhigh' };
  if (filesCount >= 5) return { model: 'opus', effort: 'high' };
  if (filesCount <= 1 && descLen < 100) return { model: 'haiku', effort: 'default' };
  if (task.priority === 'HIGH' || filesCount >= 3) return { model: 'sonnet', effort: 'high' };
  return { model: 'sonnet', effort: 'medium' };
}

// One tier up. Never auto-escalates to fable — pin that by hand (--model fable)
// on a task that stays blocked.
function escalateRouting({ model, effort }) {
  if (model === 'haiku') return { model: 'sonnet', effort: 'high' };
  if (model === 'sonnet') return { model: 'opus', effort: 'high' };
  return { model, effort: 'xhigh' };
}

function isFixTask(task) {
  return Boolean(task.parent_task_id) && /^Fix:/i.test(task.title || '');
}

// Stored routing counts as explicit unless it is the old schema's implicit
// 'sonnet' default (pre-V6 rows never had an effort).
function hasExplicitRouting(task) {
  return Boolean(task.model) && !(task.model === 'sonnet' && !task.effort);
}

const DEFAULT_EFFORT = { haiku: 'default', sonnet: 'medium', opus: 'high', fable: 'high' };

// A model pinned without an effort still gets the effort its priority/size
// implies when inference agrees on the model (a pinned-opus CRITICAL task runs
// at xhigh), otherwise that model's default.
function effortForPinned(task) {
  if (task.effort && task.effort !== 'default') return task.effort;
  const inferred = inferRouting(task);
  if (inferred.model === task.model) return inferred.effort;
  return DEFAULT_EFFORT[task.model] || 'default';
}

async function resolveRouting(task) {
  if (hasExplicitRouting(task)) return { model: task.model, effort: effortForPinned(task) };

  // Fix tasks were failing review, so never route them below the parent's
  // tier; on the final attempt go one tier up before the circuit breaker trips.
  if (isFixTask(task)) {
    const parent = await getTask(task.parent_task_id);
    if (parent) {
      const base = await resolveRouting(parent);
      return (task.iteration || 1) >= MAX_FIX_ITERATIONS ? escalateRouting(base) : base;
    }
  }
  return inferRouting(task);
}

function inferModel(task) {
  return inferRouting(task).model;
}

function inferReviews(task) {
  const filesCount = (task.files_affected || '').split(',').filter(s => s.trim()).length;
  const descLen = (task.description || '').length;
  const text = ((task.title || '') + ' ' + (task.description || '')).toLowerCase();
  if (filesCount <= 1 && descLen < 100 && task.priority !== 'CRITICAL') return 'none';
  const dims = ['qa'];
  if (SECURITY_KEYWORDS.some(kw => text.includes(kw))) dims.push('security');
  const isFix = /^(Fix:|Follow-up:)/i.test(task.title) || text.includes('test');
  const isUserFacing = UX_KEYWORDS.some(kw => text.includes(kw));
  if (!isFix && isUserFacing) dims.push('pm');
  return dims.join(',');
}

function inferContextFiles(reviews) {
  if (reviews === 'none') return ['requirements-summary.md'];
  if (reviews === 'qa') return ['requirements-summary.md', 'design-system.md'];
  return ['project-overview.md', 'design-system.md', 'requirements-summary.md'];
}

// ═══ ARTIFACTS ═══

const MAX_ARTIFACT_SIZE = 51200;

async function saveArtifact(taskId, type, content, agent, iteration = 1) {
  const database = await getDb();
  if (content && content.length > MAX_ARTIFACT_SIZE) {
    const originalSize = (content.length / 1024).toFixed(0);
    content = content.substring(0, MAX_ARTIFACT_SIZE) + '\n\n[TRUNCATED — original was ' + originalSize + ' KB]';
  }
  database.run(
    'INSERT INTO task_artifacts (task_id, artifact_type, agent, content, iteration) VALUES (?, ?, ?, ?, ?)',
    [taskId, type, agent || null, content, iteration]
  );
  saveDb(database);
}

async function getArtifact(taskId, type, iteration) {
  const database = await getDb();
  const iterClause = iteration ? ' AND iteration = ' + parseInt(iteration) : '';
  const result = database.exec(
    'SELECT * FROM task_artifacts WHERE task_id = ? AND artifact_type = ?' + iterClause + ' ORDER BY created_at DESC LIMIT 1',
    [taskId, type]
  );
  if (!result.length || !result[0].values.length) return null;
  const columns = result[0].columns;
  const values = result[0].values[0];
  const artifact = {};
  columns.forEach((col, i) => { artifact[col] = values[i]; });
  return artifact;
}

async function listArtifacts(taskId) {
  const database = await getDb();
  const result = database.exec(
    'SELECT id, task_id, artifact_type, agent, iteration, length(content) as size_chars, created_at FROM task_artifacts WHERE task_id = ? ORDER BY created_at',
    [taskId]
  );
  if (!result.length) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ═══ AUTO-UNBLOCK ═══

async function autoUnblockDependents(completedTaskId) {
  // Scan every open task, not just 'blocked' ones: rows created before V6 could
  // be 'ready' with a blocked_by list, which getNextTask would skip forever.
  const allTasks = await listTasks({});
  const unblocked = [];
  for (const task of allTasks) {
    if (task.status === 'completed' || task.status === 'in_progress') continue;
    const deps = (task.blocked_by || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    if (!deps.includes(completedTaskId)) continue;
    const remaining = deps.filter(d => d !== completedTaskId);
    if (remaining.length > 0) {
      await updateTask(task.id, { blocked_by: remaining.join(',') });
    } else if (task.status === 'blocked' && task.fix_required) {
      // Blocked for another reason too (e.g. failed review 3x) — clear the
      // dependency but leave it blocked for a human.
      await updateTask(task.id, { blocked_by: null });
    } else {
      await updateTask(task.id, { status: 'ready', blocked_by: null });
      await addHistory(task.id, 'auto-unblock', null, task.status, 'ready');
      unblocked.push(task.id);
    }
  }
  return unblocked;
}

// Close database
async function close() {
  if (db) {
    saveDb(db);
    db.close();
    db = null;
  }
  releaseLock();
}

module.exports = {
  getDb, saveDb, initializeSchema, migrateSchema,
  addTask, getTask, listTasks, updateTask, openDependencies,
  claimTask, releaseTask, completeTask, blockTask, unblockTask,
  addHistory, getHistory,
  startSession, endSession, getActiveSessions, getTasksBySession, assignTaskToSession,
  getStats, getAgentStats, getStaleTasks, getNextTask,
  conflictCheck, suggestBatch, getDependencyTree, exportTasks,
  inferModel, inferRouting, escalateRouting, resolveRouting, isFixTask, MAX_FIX_ITERATIONS,
  inferReviews, inferContextFiles,
  saveArtifact, getArtifact, listArtifacts,
  autoUnblockDependents,
  close
};
