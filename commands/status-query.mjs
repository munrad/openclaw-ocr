/**
 * commands/status-query.mjs — Status & locks query commands for Telegram /status and /locks
 *
 * Provides formatted, Telegram-friendly output for agent statuses and branch locks.
 * Shares the same status rendering contract used by OCR Telegram surfaces.
 *
 * Commands:
 *   ocr status-query [filter]           — agent status summary
 *   ocr locks-query [--kind branch]     — list active locks
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseHgetall } from '../lib/redis.mjs';
import { KEYS, KNOWN_AGENTS, KNOWN_DAEMONS } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { readDaemonHeartbeat } from '../lib/daemon-heartbeat.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_EMOJI = {
  working: '🟢', testing: '🟢', reviewing: '🟢',
  waiting: '🟡', starting: '🟡',
  blocked: '🔴', failed: '🔴', stale: '⚫',
  idle: '⚪',
  completed: '✅',
};

const STATE_PRIORITY = {
  blocked: 0, failed: 1, stale: 2,
  working: 3, testing: 4, reviewing: 5,
  waiting: 6, starting: 7,
  completed: 8,
  idle: 9,
};

const ACTIVE_STATES = new Set(['working', 'testing', 'reviewing', 'waiting', 'starting']);
const BLOCKED_STATES = new Set(['blocked', 'failed', 'stale']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(updatedAt) {
  if (!updatedAt) return '';
  const ts = parseInt(updatedAt, 10);
  if (isNaN(ts)) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function minutesLeft(ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return '0m';
  if (ttlSeconds < 60) return `${ttlSeconds}s`;
  return `${Math.ceil(ttlSeconds / 60)}m`;
}

function currentWork(statusObj) {
  return statusObj.task || statusObj.step || statusObj.status || statusObj.title || '';
}

/**
 * Fetch all agent statuses from Redis.
 */
async function getAllAgentStatuses() {
  const agents = [];
  for (const agentId of KNOWN_AGENTS) {
    const raw = await withRetry(() => redisRaw(['HGETALL', KEYS.agentStatus(agentId)]));
    const status = parseHgetall(raw);
    agents.push({
      id: agentId,
      state: status.state || 'idle',
      step: status.step || '',
      task: status.task || '',
      status: status.status || '',
      progress: status.progress || '',
      branch: status.branch || '',
      blocked_by: status.blocked_by || '',
      updated_at: status.updated_at || '',
      title: status.title || '',
      branch_lock: status.branch_lock || '',
      last_degraded_at: status.last_degraded_at || '',
      last_degraded_reason: status.last_degraded_reason || '',
      last_auto_idle_at: status.last_auto_idle_at || '',
      last_incident_marker: status.last_incident_marker || '',
      run_epoch: status.run_epoch || '',
      reconcile_epoch: status.reconcile_epoch || '',
    });
  }
  return agents;
}

/**
 * Get all branch locks with TTL.
 */
async function getAllBranchLocks() {
  const locks = [];
  let cursor = '0';
  const pattern = 'openclaw:locks:res:branch:*';

  do {
    const raw = await withRetry(() => redisRaw(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '100']));
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    cursor = clean[0] || '0';

    for (let i = 1; i < clean.length; i++) {
      const key = clean[i];
      if (!key || key === '(empty list or set)' || key === '(empty array)') continue;

      try {
        const owner = await withRetry(() => redis('GET', key));
        const ttlRaw = await withRetry(() => redis('TTL', key));
        const ttlVal = parseInt(ttlRaw, 10);

        const branchMatch = key.match(/^openclaw:locks:res:branch:(.+)$/);
        const branchName = branchMatch ? branchMatch[1] : key.replace('openclaw:locks:res:', '');

        if (owner && owner !== '(nil)' && owner !== 'nil') {
          locks.push({
            branch: branchName,
            owner,
            ttl: ttlVal > 0 ? ttlVal : 0,
          });
        }
      } catch {
        // skip
      }
    }
  } while (cursor !== '0');

  return locks;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render a single agent line (compact, for summary view).
 */
function renderAgentLine(a) {
  const emoji = STATE_EMOJI[a.state] || '⚪';
  const work = currentWork(a);
  let line = `${emoji} <b>${a.id}</b>`;

  if (a.state === 'blocked' && a.blocked_by) {
    line += ` — blocked: ждёт ${a.blocked_by}`;
  } else if (a.state === 'failed') {
    line += ` — failed: ${work || 'unknown'}`;
  } else if (a.state === 'stale') {
    line += ` — stale: heartbeat missing`;
    if (work) line += ` • ${work}`;
  } else if (work) {
    line += ` — ${work}`;
    if (a.progress) line += ` (${a.progress}%)`;
  } else {
    line += ` — ${a.state}`;
  }

  return line;
}

/**
 * Render agent detail line (branch, time ago).
 */
function renderAgentDetail(a) {
  const details = [];
  if (a.branch) details.push(`branch: ${a.branch}`);
  const ago = timeAgo(a.updated_at);
  if (ago) details.push(ago);
  return details.length ? `   ${details.join(' | ')}` : '';
}

/**
 * Render full agent detail (for single-agent query).
 */
function renderAgentFull(a) {
  const emoji = STATE_EMOJI[a.state] || '⚪';
  const lines = [
    `${emoji} <b>${a.id}</b>`,
    '',
  ];

  const fields = [
    ['State', a.state],
    ['Task', a.task || '—'],
    ['Step', a.step || '—'],
    ['Status', a.status || '—'],
    ['Progress', a.progress ? `${a.progress}%` : '—'],
    ['Branch', a.branch || '—'],
    ['Branch Lock', a.branch_lock === 'true' ? '🔒 yes' : '—'],
    ['Blocked By', a.blocked_by || '—'],
    ['Title', a.title || '—'],
    ['Updated', timeAgo(a.updated_at) || '—'],
    ['Last Incident Marker', a.last_incident_marker || '—'],
    ['Last Degraded', timeAgo(a.last_degraded_at) || '—'],
    ['Last Degraded Reason', a.last_degraded_reason || '—'],
    ['Last Auto Idle', timeAgo(a.last_auto_idle_at) || '—'],
    ['Run Epoch', a.run_epoch || '—'],
    ['Reconcile Epoch', a.reconcile_epoch || '—'],
  ];

  for (const [label, value] of fields) {
    if (value !== '—') {
      lines.push(`<b>${label}:</b> ${value}`);
    }
  }

  // Parent-child tree (best effort)
  try {
    const parent = redis('GET', KEYS.agentParent(a.id));
    if (parent && parent !== '(nil)') {
      lines.push(`<b>Parent:</b> ${parent}`);
    }
  } catch { /* best effort */ }
  try {
    const childrenRaw = redisRaw(['SMEMBERS', KEYS.agentChildren(a.id)]);
    if (childrenRaw && childrenRaw.trim() && childrenRaw.trim() !== '(empty array)' && childrenRaw.trim() !== '(nil)') {
      const children = childrenRaw.split('\n').map(l => l.trim().replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
      if (children.length > 0) {
        lines.push(`<b>Children:</b> ${children.join(', ')}`);
      }
    }
  } catch { /* best effort */ }

  return lines.join('\n');
}

/**
 * Render background daemon status lines.
 */
function renderDaemonStatus() {
  const lines = ['', '\ud83d\udd04 <b>Background Services</b>'];
  const now = Math.floor(Date.now() / 1000);
  for (const name of KNOWN_DAEMONS) {
    const lastBeat = readDaemonHeartbeat(name);
    if (lastBeat) {
      const ago = now - lastBeat;
      const agoStr = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;
      lines.push(`  ${name}: \u2705 running (${agoStr})`);
    } else {
      lines.push(`  ${name}: \u26a0\ufe0f not detected`);
    }
  }
  return lines;
}

/**
 * Render summary for a list of agents.
 */
function renderSummaryText(agents) {
  agents.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] ?? 9;
    const pb = STATE_PRIORITY[b.state] ?? 9;
    if (pa !== pb) return pa - pb;
    const ta = parseInt(a.updated_at || '0', 10) || 0;
    const tb = parseInt(b.updated_at || '0', 10) || 0;
    return tb - ta;
  });

  const lines = ['🤖 <b>Agent Status</b>', ''];
  const idle = [];
  let activeCount = 0;
  let blockedCount = 0;
  let staleCount = 0;

  for (const a of agents) {
    if (a.state === 'idle' || (!a.state || a.state === '')) {
      idle.push(a.id);
      continue;
    }

    if (a.state === 'stale') staleCount++;
    if (BLOCKED_STATES.has(a.state)) blockedCount++;
    else if (a.state !== 'completed') activeCount++;

    lines.push(renderAgentLine(a));
    const detail = renderAgentDetail(a);
    if (detail) lines.push(detail);
    lines.push('');
  }

  if (idle.length > 0) {
    lines.push(`⚪ <i>Idle: ${idle.join(', ')}</i>`);
    lines.push('');
  }

  lines.push(...renderDaemonStatus());
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Active: ${activeCount} | Blocked: ${blockedCount} | Stale: ${staleCount}`);

  return { text: lines.join('\n'), summary: { active: activeCount, blocked: blockedCount, stale: staleCount } };
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * ocr status-query [filter]
 *
 * Filters:
 *   (none)        — full summary of all agents
 *   active        — only working/testing/reviewing/waiting/starting
 *   blocked       — only blocked/failed/stale
 *   <agent-name>  — detailed status of one agent
 *   branch <name> — who's working on this branch
 */
export async function cmdStatusQuery(args) {
  const parsedArgs = args || [];
  const filter = parsedArgs[0] || null;

  const allAgents = await getAllAgentStatuses();

  if (filter === 'branch') {
    const branchName = parsedArgs[1];
    if (!branchName) throw argError('status-query branch requires <name>');

    const matched = allAgents.filter(a => a.branch && a.branch === branchName);

    if (matched.length === 0) {
      output({
        ok: true,
        text: `🔍 Никто не работает в ветке <code>${branchName}</code>`,
        agents: [],
        summary: { active: 0, blocked: 0, stale: 0 },
      });
      return;
    }

    const lines = [`🌿 <b>Branch: ${branchName}</b>`, ''];
    for (const a of matched) {
      lines.push(renderAgentLine(a));
      const detail = renderAgentDetail(a);
      if (detail) lines.push(detail);
      lines.push('');
    }

    output({
      ok: true,
      text: lines.join('\n').trimEnd(),
      agents: matched,
      summary: { active: matched.length, blocked: 0, stale: 0 },
    });
    return;
  }

  if (filter === 'active') {
    const filtered = allAgents.filter(a => ACTIVE_STATES.has(a.state));
    if (filtered.length === 0) {
      output({
        ok: true,
        text: '🤖 Нет активных агентов',
        agents: [],
        summary: { active: 0, blocked: 0, stale: 0 },
      });
      return;
    }
    const { text, summary } = renderSummaryText(filtered);
    output({ ok: true, text, agents: filtered, summary });
    return;
  }

  if (filter === 'blocked') {
    const filtered = allAgents.filter(a => BLOCKED_STATES.has(a.state));
    if (filtered.length === 0) {
      output({
        ok: true,
        text: '🤖 Нет заблокированных агентов',
        agents: [],
        summary: { active: 0, blocked: 0, stale: 0 },
      });
      return;
    }
    const { text, summary } = renderSummaryText(filtered);
    output({ ok: true, text, agents: filtered, summary });
    return;
  }

  if (filter) {
    const agent = allAgents.find(a => a.id === filter);
    if (!agent) {
      const statusRaw = await redis(['HGETALL', KEYS.agentStatus(filter)]);
      if (statusRaw && statusRaw.length > 0) {
        const parsed = parseHgetall(statusRaw);
        const agentObj = { id: filter, ...parsed };
        output({
          ok: true,
          text: renderAgentFull(agentObj),
          agents: [agentObj],
          summary: { active: 0, blocked: 0, stale: 0 },
        });
        return;
      }
      output({ ok: false, error: 'not_found', message: `Agent '${filter}' not found` }, 1);
      return;
    }

    output({
      ok: true,
      text: renderAgentFull(agent),
      agents: [agent],
      summary: { active: 0, blocked: 0, stale: 0 },
    });
    return;
  }

  const { text, summary } = renderSummaryText(allAgents);
  output({ ok: true, text, agents: allAgents, summary });
}

/**
 * ocr locks-query [--kind branch]
 *
 * Lists active locks. Default: branch locks.
 */
export async function cmdLocksQuery(args) {
  const parsedArgs = args || [];
  let kind = 'branch';

  for (let i = 0; i < parsedArgs.length; i++) {
    if (parsedArgs[i] === '--kind' && parsedArgs[i + 1]) {
      kind = parsedArgs[i + 1];
      i++;
    }
  }

  if (kind !== 'branch') {
    throw argError(`Unknown lock kind '${kind}'. Currently supported: branch`);
  }

  const locks = await getAllBranchLocks();

  if (locks.length === 0) {
    output({
      ok: true,
      text: '🔒 No active branch locks',
      locks: [],
    });
    return;
  }

  locks.sort((a, b) => b.ttl - a.ttl);

  const lines = ['🔒 <b>Branch Locks</b>', ''];
  for (const lock of locks) {
    lines.push(`<code>${lock.branch}</code> → <b>${lock.owner}</b> (${minutesLeft(lock.ttl)} left)`);
  }
  lines.push('');
  lines.push(`Total: ${locks.length}`);

  output({
    ok: true,
    text: lines.join('\n'),
    locks,
  });
}
