/**
 * commands/bugs.mjs — Bug Tracker via Redis
 *
 * Any agent can report bugs; nerey/coder triage and fix.
 *
 * Redis keys:
 *   openclaw:bugs:counter        — auto-increment ID
 *   openclaw:bugs:<id>           — hash (severity, description, reporter, assignee, status, created_at, updated_at, comment)
 *   openclaw:bugs:open           — sorted set (score = timestamp, member = bug-id)
 *   openclaw:bugs:fixed          — sorted set
 *   openclaw:bugs:wontfix        — sorted set
 *   openclaw:events:stream       — stream event on creation (type=bug_reported)
 *
 * CLI:
 *   ocr bug-report <severity> '<description>' [--reporter <agent>]
 *   ocr bug-list [--status open|fixed|wontfix|all] [--severity P0|P1|P2|P3] [--reporter <agent>]
 *   ocr bug-fix <bug-id> [--comment '<text>']
 *   ocr bug-wontfix <bug-id> [--comment '<text>']
 *   ocr bug-assign <bug-id> <agent>
 *   ocr bug-detail <bug-id>
 */

import { output, argError } from '../lib/errors.mjs';
import { redis, redisRaw, parseHgetall } from '../lib/redis.mjs';
import { KEYS, now } from '../lib/schema.mjs';
import { KNOWN_AGENTS as KNOWN_AGENTS_SET, validateAgentId } from '../lib/known-agents.mjs';

// ─── Key helpers ─────────────────────────────────────────────────────────────

const BUG_PREFIX  = 'openclaw:bugs';
const bugKey      = (id) => `${BUG_PREFIX}:${id}`;
const COUNTER_KEY = `${BUG_PREFIX}:counter`;
const OPEN_SET    = `${BUG_PREFIX}:open`;
const FIXED_SET   = `${BUG_PREFIX}:fixed`;
const WONTFIX_SET = `${BUG_PREFIX}:wontfix`;

const VALID_SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const VALID_STATUSES   = ['open', 'fixed', 'wontfix'];

// Known agent IDs — from lib/schema.mjs (single source of truth)
const KNOWN_AGENTS = [...KNOWN_AGENTS_SET];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Levenshtein distance for did-you-mean suggestions.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Find closest agent name for did-you-mean hint.
 */
function suggestAgent(input) {
  let best = null, bestDist = Infinity;
  for (const a of KNOWN_AGENTS) {
    const d = levenshtein(input.toLowerCase(), a.toLowerCase());
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return bestDist <= 3 ? best : null;
}

/**
 * Validate agent ID against known agents list.
 * Throws argError with did-you-mean hint if invalid.
 */
function validateAgent(agentId) {
  if (KNOWN_AGENTS.includes(agentId)) return;
  const suggestion = suggestAgent(agentId);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  throw argError(`bug-assign: unknown agent '${agentId}'. Known agents: ${KNOWN_AGENTS.join(', ')}.${hint}`);
}

/**
 * Atomic status transition via Lua script.
 * Checks current status == expectedStatus, then sets new status + fields.
 * Returns 'ok' on success, 'wrong_status:<current>' on mismatch, 'not_found' if key missing.
 */
function atomicStatusTransition(bugId, expectedStatus, newStatus, extraFields) {
  // KEYS[1] = bug hash key
  // KEYS[2] = source sorted set (to ZREM from)
  // KEYS[3] = target sorted set (to ZADD to)
  // ARGV[1] = expected current status
  // ARGV[2] = new status
  // ARGV[3] = timestamp
  // ARGV[4] = comment
  // ARGV[5] = bugId (member for sorted sets)
  const sourceSet = expectedStatus === 'open' ? OPEN_SET : expectedStatus === 'fixed' ? FIXED_SET : WONTFIX_SET;
  const targetSet = newStatus === 'fixed' ? FIXED_SET : WONTFIX_SET;
  const ts = extraFields.updated_at || now();
  const comment = extraFields.comment || '';

  const lua = `
    local key = KEYS[1]
    local srcSet = KEYS[2]
    local dstSet = KEYS[3]
    local expected = ARGV[1]
    local newSt = ARGV[2]
    local ts = ARGV[3]
    local comment = ARGV[4]
    local bugMember = ARGV[5]
    local cur = redis.call('HGET', key, 'status')
    if cur == false then return 'not_found' end
    if cur ~= expected then return 'wrong_status:' .. tostring(cur) end
    redis.call('HSET', key, 'status', newSt, 'updated_at', ts, 'comment', comment)
    redis.call('ZREM', srcSet, bugMember)
    redis.call('ZADD', dstSet, ts, bugMember)
    return 'ok'
  `;

  const result = redis('EVAL', lua, '3',
    bugKey(bugId), sourceSet, targetSet,
    expectedStatus, newStatus, ts, comment, bugId
  );
  return result;
}

// ─── Helpers (continued) ─────────────────────────────────────────────────────

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reporter' && i + 1 < args.length)       { flags.reporter  = args[++i]; }
    else if (args[i] === '--status' && i + 1 < args.length)    { flags.status    = args[++i]; }
    else if (args[i] === '--severity' && i + 1 < args.length)  { flags.severity  = args[++i]; }
    else if (args[i] === '--comment' && i + 1 < args.length)   { flags.comment   = args[++i]; }
    else { positional.push(args[i]); }
  }
  return { flags, positional };
}

function getReporter(flags) {
  return flags.reporter || process.env.OCR_AGENT_ID || 'unknown';
}

function getBugOrThrow(id) {
  const raw = redisRaw(['HGETALL', bugKey(id)]);
  const h = parseHgetall(raw);
  if (!h.status) throw argError(`Bug ${id} not found`);
  return h;
}

// ─── bug-report ──────────────────────────────────────────────────────────────

export async function cmdBugReport(args) {
  const { flags, positional } = parseArgs(args);
  const severity = positional[0]?.toUpperCase();
  const description = positional.slice(1).join(' ');

  if (!severity || !VALID_SEVERITIES.includes(severity)) {
    throw argError(`bug-report: severity required (${VALID_SEVERITIES.join('/')}). Usage: ocr bug-report <severity> '<description>'`);
  }
  if (!description) {
    throw argError('bug-report: description required');
  }

  const reporter = getReporter(flags);
  const ts = now();

  // Auto-increment ID
  const idNum = redis('INCR', COUNTER_KEY).trim();
  const bugId = `BUG-${idNum}`;

  // Write hash
  redis('HSET', bugKey(bugId),
    'severity', severity,
    'description', description,
    'reporter', reporter,
    'assignee', '',
    'status', 'open',
    'created_at', ts,
    'updated_at', ts,
    'comment', '',
  );

  // Add to open sorted set
  redis('ZADD', OPEN_SET, ts, bugId);

  // Emit stream event
  const priority = severity === 'P0' ? 'critical' : 'normal';
  redis('XADD', KEYS.eventsStream, '*',
    'type', 'bug_reported',
    'bug_id', bugId,
    'severity', severity,
    'reporter', reporter,
    'priority', priority,
    'data', JSON.stringify({ bug_id: bugId, severity, description, reporter, priority }),
  );

  output({
    ok: true,
    bug_id: bugId,
    severity,
    reporter,
    priority,
    text: `🐛 ${bugId} [${severity}] reported by ${reporter}${priority === 'critical' ? ' ⚠️ CRITICAL' : ''}`,
  });
}

// ─── bug-list ────────────────────────────────────────────────────────────────

export async function cmdBugList(args) {
  const { flags } = parseArgs(args);
  const statusFilter   = flags.status   || 'open';
  const severityFilter = flags.severity?.toUpperCase() || null;
  const reporterFilter = flags.reporter || null;

  if (severityFilter && !VALID_SEVERITIES.includes(severityFilter)) {
    throw argError(`bug-list: invalid severity '${severityFilter}'. Must be ${VALID_SEVERITIES.join('/')}`);
  }
  if (statusFilter !== 'all' && !VALID_STATUSES.includes(statusFilter)) {
    throw argError(`bug-list: invalid status '${statusFilter}'. Must be ${VALID_STATUSES.join('/')}/all`);
  }

  // Collect bug IDs from sorted sets
  let bugIds = [];
  if (statusFilter === 'all') {
    for (const set of [OPEN_SET, FIXED_SET, WONTFIX_SET]) {
      const raw = redisRaw(['ZRANGE', set, '0', '-1']).trim();
      if (raw) bugIds.push(...raw.split('\n').map(l => l.trim()).filter(Boolean));
    }
  } else {
    const set = statusFilter === 'open' ? OPEN_SET : statusFilter === 'fixed' ? FIXED_SET : WONTFIX_SET;
    const raw = redisRaw(['ZRANGE', set, '0', '-1']).trim();
    if (raw) bugIds = raw.split('\n').map(l => l.trim()).filter(Boolean);
  }

  // Fetch details in batch via Lua pipeline (avoids N+1 Redis calls)
  const bugs = [];
  if (bugIds.length > 0) {
    // Use Lua script to batch-fetch all bug hashes in a single round-trip
    // Returns JSON array of {id, ...fields} objects
    const luaBatch = `
      local result = {}
      for i, id in ipairs(ARGV) do
        local key = KEYS[1] .. ':' .. id
        local data = redis.call('HGETALL', key)
        if #data > 0 then
          local obj = '{"id":' .. cjson.encode(id)
          for j = 1, #data, 2 do
            obj = obj .. ',' .. cjson.encode(data[j]) .. ':' .. cjson.encode(data[j+1])
          end
          obj = obj .. '}'
          result[#result+1] = obj
        end
      end
      return '[' .. table.concat(result, ',') .. ']'
    `;
    try {
      const raw = redis('EVAL', luaBatch, '1', BUG_PREFIX, ...bugIds);
      const parsed = JSON.parse(raw);
      for (const b of parsed) {
        if (!b.status) continue;
        if (severityFilter && b.severity !== severityFilter) continue;
        if (reporterFilter && b.reporter !== reporterFilter) continue;
        bugs.push(b);
      }
    } catch {
      // Fallback to sequential reads if Lua fails (e.g., too many args)
      for (const id of bugIds) {
        const h = parseHgetall(redisRaw(['HGETALL', bugKey(id)]));
        if (!h.status) continue;
        if (severityFilter && h.severity !== severityFilter) continue;
        if (reporterFilter && h.reporter !== reporterFilter) continue;
        bugs.push({ id, ...h });
      }
    }
  }

  // Sort by severity (P0 first) then created_at desc
  const sevOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
  bugs.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9) || Number(b.created_at) - Number(a.created_at));

  // Format
  const lines = bugs.map(b => {
    const assignee = b.assignee ? ` → ${b.assignee}` : '';
    return `${b.id} [${b.severity}] ${b.status}${assignee} — ${b.description.slice(0, 80)}`;
  });

  output({
    ok: true,
    count: bugs.length,
    bugs,
    text: bugs.length === 0
      ? `📋 No bugs (${statusFilter})`
      : `📋 Bugs (${statusFilter}): ${bugs.length}\n${lines.join('\n')}`,
  });
}

// ─── bug-fix ─────────────────────────────────────────────────────────────────

export async function cmdBugFix(args) {
  const { flags, positional } = parseArgs(args);
  const bugId = positional[0];
  if (!bugId) throw argError('bug-fix: <bug-id> required');

  const ts = now();
  const comment = flags.comment || '';

  const result = atomicStatusTransition(bugId, 'open', 'fixed', { updated_at: ts, comment });

  if (result === 'not_found') {
    throw argError(`Bug ${bugId} not found`);
  }
  if (result.startsWith('wrong_status:')) {
    const current = result.split(':')[1];
    output({ ok: false, error: 'already_closed', bug_id: bugId, status: current, text: `${bugId} already ${current}` });
    return;
  }

  output({
    ok: true,
    bug_id: bugId,
    status: 'fixed',
    text: `✅ ${bugId} fixed${comment ? ` — ${comment}` : ''}`,
  });
}

// ─── bug-wontfix ─────────────────────────────────────────────────────────────

export async function cmdBugWontfix(args) {
  const { flags, positional } = parseArgs(args);
  const bugId = positional[0];
  if (!bugId) throw argError('bug-wontfix: <bug-id> required');

  const ts = now();
  const comment = flags.comment || '';

  const result = atomicStatusTransition(bugId, 'open', 'wontfix', { updated_at: ts, comment });

  if (result === 'not_found') {
    throw argError(`Bug ${bugId} not found`);
  }
  if (result.startsWith('wrong_status:')) {
    const current = result.split(':')[1];
    output({ ok: false, error: 'already_closed', bug_id: bugId, status: current, text: `${bugId} already ${current}` });
    return;
  }

  output({
    ok: true,
    bug_id: bugId,
    status: 'wontfix',
    text: `🚫 ${bugId} wontfix${comment ? ` — ${comment}` : ''}`,
  });
}

// ─── bug-assign ──────────────────────────────────────────────────────────────

export async function cmdBugAssign(args) {
  const bugId = args[0];
  const agent = args[1];
  if (!bugId || !agent) throw argError('bug-assign: <bug-id> <agent> required');

  validateAgent(agent);

  const h = getBugOrThrow(bugId);
  const ts = now();

  redis('HSET', bugKey(bugId), 'assignee', agent, 'updated_at', ts);

  output({
    ok: true,
    bug_id: bugId,
    assignee: agent,
    text: `👤 ${bugId} assigned to ${agent}`,
  });
}

// ─── bug-detail ──────────────────────────────────────────────────────────────

export async function cmdBugDetail(args) {
  const bugId = args[0];
  if (!bugId) throw argError('bug-detail: <bug-id> required');

  const h = getBugOrThrow(bugId);

  const lines = [
    `🐛 ${bugId}`,
    `  Severity:  ${h.severity}`,
    `  Status:    ${h.status}`,
    `  Reporter:  ${h.reporter}`,
    `  Assignee:  ${h.assignee || '—'}`,
    `  Created:   ${h.created_at}`,
    `  Updated:   ${h.updated_at}`,
    `  Comment:   ${h.comment || '—'}`,
    `  Description: ${h.description}`,
  ];

  output({
    ok: true,
    bug_id: bugId,
    bug: { id: bugId, ...h },
    text: lines.join('\n'),
  });
}
