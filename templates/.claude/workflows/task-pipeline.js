export const meta = {
  name: 'task-pipeline',
  description: 'Develop, review and fix-loop claimed task-DB tasks (launched by /work-task)',
  whenToUse: 'Only via the /work-task skill, which claims tasks first and records outcomes in the task DB afterwards. Expects args.tasks = payloads from `node tasks/cli.js claim <id> --json`.',
  phases: [
    { title: 'Develop', detail: 'developer agent per task, model/effort from claim routing' },
    { title: 'Review', detail: 'reviewer agent on the assigned dimensions' },
    { title: 'Fix', detail: 'fix + scoped verification, max 3 rounds, last round escalates a tier' },
  ],
}

// Deterministic version of the loop in .claude/ORCHESTRATION.md. The script has
// no filesystem access, so agents read/write the task DB themselves (artifacts);
// task status changes stay with the /work-task skill in the main session.

const MAX_FIX_ROUNDS = (args && args.maxFixRounds) || 3
const SCOPED_REVIEW = { model: 'sonnet', effort: 'high' }

const DEV_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'], description: 'blocked = could not complete (e.g. needs a new dependency or a decision)' },
    summary: { type: 'string', description: 'one or two sentences on what changed' },
    files_modified: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'pass/fail counts or "no tests configured"' },
    issues: { type: 'array', items: { type: 'string' }, description: 'empty if none' },
  },
  required: ['status', 'summary', 'files_modified', 'issues'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'PASS_WITH_WARNINGS', 'FAIL'] },
    summary: { type: 'string' },
    critical: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          location: { type: 'string', description: 'file:line' },
          fixed_when: { type: 'string', description: 'what a correct fix looks like' },
        },
        required: ['issue'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'critical', 'warnings'],
}

function escalate(routing) {
  if (routing.model === 'haiku') return { model: 'sonnet', effort: 'high' }
  if (routing.model === 'sonnet') return { model: 'opus', effort: 'high' }
  return { model: routing.model, effort: 'xhigh' }
}

function withRouting(routing, extra) {
  const o = { ...extra }
  if (routing.model) o.model = routing.model
  if (routing.effort && routing.effort !== 'default') o.effort = routing.effort
  return o
}

// Error recovery rule: re-spawn once, then give up.
async function once(fn) {
  return (await fn()) || (await fn())
}

function formatIssues(critical) {
  return critical.map(c => `- ${c.issue}${c.location ? ` (${c.location})` : ''}${c.fixed_when ? ` — fixed when: ${c.fixed_when}` : ''}`).join('\n')
}

function devPrompt(task, iteration, critical, fixRound) {
  const lines = [
    `Task ID: ${task.id} | Iteration: ${iteration}`,
    `Title: ${task.title}`,
    `Priority: ${task.priority}`,
    `Description: ${task.description || '(none)'}`,
    `Files affected: ${task.files_affected.length ? task.files_affected.join(', ') : '(not listed — locate them)'}`,
    `Context files: ${task.context_files.join(', ')}`,
  ]
  if (task.fix_required) lines.push(`Previously recorded blocker: ${task.fix_required}`)
  if (critical) {
    lines.push('', `FIX ROUND ${fixRound} of ${MAX_FIX_ROUNDS}. The reviewer failed the previous iteration. Fix exactly these issues and nothing else:`, formatIssues(critical))
  }
  lines.push('', `Implement, run tests, save the dev_report artifact with --iteration ${iteration}, and return your report.`)
  return lines.join('\n')
}

function reviewPrompt(task, iteration) {
  return [
    `Task ID: ${task.id} | Iteration: ${iteration}`,
    `Title: ${task.title}`,
    `Description: ${task.description || '(none)'}`,
    `REVIEW DIMENSIONS: ${task.reviews}`,
    '',
    `Retrieve the dev report (node tasks/cli.js artifact get ${task.id} --type dev_report), review, save the review_report artifact with --iteration ${iteration}, and return your review.`,
  ].join('\n')
}

function extraReviewPrompt(task, iteration, agentName) {
  return [
    `Task ID: ${task.id} | Iteration: ${iteration}`,
    `Title: ${task.title}`,
    `Description: ${task.description || '(none)'}`,
    `Files affected: ${task.files_affected.length ? task.files_affected.join(', ') : '(see the dev report)'}`,
    `REVIEW DIMENSIONS: ${task.reviews}`,
    'FIX_MODE: false — review only, do not modify any files.',
    '',
    `You are reviewing alongside the main reviewer, from your own specialty. Read the dev report (node tasks/cli.js artifact get ${task.id} --type dev_report), review the change, save your report with: node tasks/cli.js artifact save ${task.id} --type ${agentName}_report --iteration ${iteration} --agent ${agentName} --stdin, and return PASS, PASS_WITH_WARNINGS or FAIL.`,
  ].join('\n')
}

const SEVERITY = { PASS: 0, PASS_WITH_WARNINGS: 1, FAIL: 2 }

// Worst status wins; findings from extra reviewers are tagged with their name.
function mergeReviews(named) {
  const worst = named.reduce((a, r) => (SEVERITY[r.review.status] > SEVERITY[a] ? r.review.status : a), 'PASS')
  const tag = (name, text) => (name === 'reviewer' ? text : `[${name}] ${text}`)
  return {
    status: worst,
    summary: named.map(r => tag(r.name, r.review.summary)).join(' | '),
    critical: named.flatMap(r => r.review.critical.map(c => ({ ...c, issue: tag(r.name, c.issue) }))),
    warnings: named.flatMap(r => r.review.warnings.map(w => tag(r.name, w))),
  }
}

function scopedPrompt(task, iteration, critical) {
  return [
    'REVIEW MODE: SCOPED FIX VERIFICATION',
    `Task ID: ${task.id} | Iteration: ${iteration}`,
    'ORIGINAL ISSUES:',
    formatIssues(critical),
    '',
    `Verify ONLY these issues are fixed. Save the review_report artifact with --iteration ${iteration} and return PASS or FAIL.`,
  ].join('\n')
}

async function runTask(task) {
  const tag = `#${task.id}`
  const base = { model: task.model, effort: task.effort }
  const out = { id: task.id, title: task.title, fix_rounds: 0, model: base.model, reviewed: task.reviews !== 'none' }

  const dev = await once(() => agent(devPrompt(task, 1, null, 0),
    withRouting(base, { label: `develop ${tag}`, phase: 'Develop', agentType: 'developer', schema: DEV_SCHEMA })))
  if (!dev) return { ...out, outcome: 'ERROR', summary: 'Developer agent failed twice' }
  if (dev.status === 'blocked') return { ...out, outcome: 'DEV_BLOCKED', summary: dev.summary, issues: dev.issues }

  const merged = { summary: dev.summary, files_modified: dev.files_modified, dev_issues: dev.issues }
  if (task.reviews === 'none') return { ...out, ...merged, outcome: 'PASS', warnings: [] }

  // Main reviewer plus any project-specific reviewers (extra_reviewers from the
  // claim payload) in parallel. Fix rounds are verified by the main reviewer only.
  const extras = task.extra_reviewers || []
  const reviews = await parallel([
    () => once(() => agent(reviewPrompt(task, 1),
      { label: `review ${tag}`, phase: 'Review', agentType: 'reviewer', schema: REVIEW_SCHEMA }))
      .then(review => ({ name: 'reviewer', review })),
    ...extras.map(name => () => once(() => agent(extraReviewPrompt(task, 1, name),
      { label: `${name} ${tag}`, phase: 'Review', agentType: name, schema: REVIEW_SCHEMA }))
      .then(review => ({ name, review }))),
  ])
  const failed = ['reviewer', ...extras].filter((name, i) => !reviews[i] || !reviews[i].review)
  if (failed.length) {
    return { ...out, ...merged, outcome: 'ERROR', summary: `Review agent(s) failed twice: ${failed.join(', ')}` }
  }
  let review = mergeReviews(reviews)
  const warnings = [...review.warnings]

  let fixRound = 0
  let routing = base
  while (review.status === 'FAIL' && fixRound < MAX_FIX_ROUNDS) {
    fixRound++
    const iteration = fixRound + 1
    if (fixRound === MAX_FIX_ROUNDS) {
      routing = escalate(base)
      log(`${tag}: final fix round, escalating to ${routing.model}/${routing.effort}`)
    }
    const critical = review.critical
    const fix = await once(() => agent(devPrompt(task, iteration, critical, fixRound),
      withRouting(routing, { label: `fix ${fixRound} ${tag}`, phase: 'Fix', agentType: 'developer', schema: DEV_SCHEMA })))
    if (!fix) return { ...out, ...merged, fix_rounds: fixRound, outcome: 'ERROR', summary: `Fix developer failed twice in round ${fixRound}` }
    if (fix.status === 'blocked') return { ...out, ...merged, fix_rounds: fixRound, outcome: 'DEV_BLOCKED', summary: fix.summary, issues: fix.issues }
    merged.files_modified = [...new Set([...merged.files_modified, ...fix.files_modified])]

    const verify = await once(() => agent(scopedPrompt(task, iteration, critical),
      withRouting(SCOPED_REVIEW, { label: `verify ${fixRound} ${tag}`, phase: 'Fix', agentType: 'reviewer', schema: REVIEW_SCHEMA })))
    if (!verify) return { ...out, ...merged, fix_rounds: fixRound, outcome: 'ERROR', summary: 'Verification reviewer failed twice' }
    warnings.push(...verify.warnings)
    review = verify
  }

  return {
    ...out,
    ...merged,
    fix_rounds: fixRound,
    model: routing.model,
    outcome: review.status === 'FAIL' ? 'FAILED_REVIEW' : (warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS'),
    critical: review.status === 'FAIL' ? review.critical : [],
    warnings,
    review_summary: review.summary,
  }
}

// Tasks whose files overlap share a lane and run one after another; lanes run
// in parallel. Tasks with no files listed could touch anything, so they share
// one lane. (No worktree isolation: reviewers diff the shared working tree.)
function planLanes(tasks) {
  const lanes = []
  const unknown = []
  for (const task of tasks) {
    if (!task.files_affected.length) { unknown.push(task); continue }
    const hits = lanes.filter(l => l.files.some(f => task.files_affected.includes(f)))
    const lane = { tasks: [task], files: [...task.files_affected] }
    for (const h of hits) {
      lane.tasks.unshift(...h.tasks)
      lane.files.push(...h.files)
      lanes.splice(lanes.indexOf(h), 1)
    }
    lanes.push(lane)
  }
  if (unknown.length) lanes.push({ tasks: unknown, files: [] })
  return lanes.map(l => l.tasks.sort((a, b) => a.id - b.id))
}

const tasks = (args && args.tasks) || []
if (!tasks.length) return { results: [], error: 'No tasks passed. Run via /work-task.' }

const lanes = planLanes(tasks)
if (lanes.length < tasks.length) {
  log(`Running ${tasks.length} tasks in ${lanes.length} lane(s); tasks sharing files (or with none listed) run sequentially: ${lanes.map(l => l.map(t => '#' + t.id).join(' → ')).join(' | ')}`)
}

const laneResults = await parallel(lanes.map(lane => async () => {
  const results = []
  for (const task of lane) results.push(await runTask(task))
  return results
}))

return { results: laneResults.filter(Boolean).flat() }
