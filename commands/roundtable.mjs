/**
 * commands/roundtable.mjs — Multi-agent deliberation roundtable commands
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson, parseHgetall, parseXread, withLock } from '../lib/redis.mjs';
import { KEYS, genRoundtableId, now } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';
import { validateAgentId } from '../lib/known-agents.mjs';
import { ROUNDTABLE_TEMPLATES } from '../lib/roundtable-templates.mjs';
import { saveRoundtableHistory } from '../lib/roundtable-history.mjs';
import { ensureTaskStatusTracker, ensureBootstrappedAgentStatus } from './task-status.mjs';

/**
 * Parse a CSV agent reference string into a deduplicated array.
 * "planner, coder, tester" → ["planner", "coder", "tester"]
 */
function parseAgentRefs(value) {
  if (!value || typeof value !== 'string') return [];
  return [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
}

function cleanupRoundtableKeys(rtId, rtKey = KEYS.roundtable(rtId), streamKey = KEYS.roundtableRounds(rtId), reason = 'cleanup') {
  try {
    redis('EXPIRE', rtKey, '3600');    // short TTL on close (1h) instead of immediate DEL
    redis('EXPIRE', streamKey, '3600');
    process.stderr.write(`[ocr debug] roundtable ${rtId} cleanup: set 1h TTL (${reason})\n`);
    return true;
  } catch (err) {
    process.stderr.write(`[ocr warn] roundtable ${rtId} cleanup failed (${reason}): ${String(err.message || err)}\n`);
    return false;
  }
}

function tryAutoCompleteRoundtable(rtId, rtKey = KEYS.roundtable(rtId), streamKey = KEYS.roundtableRounds(rtId)) {
  try {
    const rawParticipants = redis('HGET', rtKey, 'participants');
    const participants = JSON.parse(rawParticipants || '[]');
    if (!Array.isArray(participants) || participants.length === 0) return false;

    const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
    const contributions = parseXread(rawStream);
    const contributedAgents = new Set(contributions.map(c => c.agent).filter(Boolean));
    const allContributed = participants.every(p => contributedAgents.has(p));

    if (!allContributed) return false;

    const completedAt = new Date().toISOString();
    redis('HSET', rtKey, 'status', 'completed', 'completed_at', completedAt);
    process.stderr.write(`[ocr debug] roundtable ${rtId} auto-completed after last contribution (${participants.length}/${participants.length})\n`);
    cleanupRoundtableKeys(rtId, rtKey, streamKey, 'auto-complete-after-contribute');
    return true;
  } catch (err) {
    process.stderr.write(`[ocr warn] roundtable ${rtId} auto-cleanup check failed: ${String(err.message || err)}\n`);
    return false;
  }
}

export async function cmdRoundtableCreate(args) {
  let topic = null, participants = null, context = null, constraints = null, template = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--topic' && args[i + 1])            { topic = args[i + 1]; i++; }
    else if (args[i] === '--participants' && args[i + 1]) { participants = args[i + 1]; i++; }
    else if (args[i] === '--context' && args[i + 1])     { context = args[i + 1]; i++; }
    else if (args[i] === '--constraints' && args[i + 1]) { constraints = args[i + 1]; i++; }
    else if (args[i] === '--template' && args[i + 1])    { template = args[i + 1]; i++; }
  }

  // Resolve template first (may provide topic default)
  if (template) {
    const tmpl = ROUNDTABLE_TEMPLATES[template];
    if (!tmpl) {
      const valid = Object.keys(ROUNDTABLE_TEMPLATES).join(', ');
      throw argError(`unknown template: ${template}. Valid: ${valid}`);
    }
    // Template provides defaults; explicit args override
    if (!topic) topic = template; // use template name as topic fallback
    if (!participants) participants = tmpl.participants.join(',');
    if (!constraints) constraints = tmpl.constraints;
  }

  if (!topic) throw argError('roundtable-create requires --topic or --template');
  if (!participants) throw argError('roundtable-create requires --participants or --template');

  // Parse participants: CSV → deduplicated array
  const participantList = [...new Set(participants.split(',').map(p => p.trim()).filter(Boolean))];

  // Validate minimum 2 unique participants
  if (participantList.length < 2) {
    output({ ok: false, error: 'roundtable requires at least 2 participants' });
    return;
  }

  const rtId = genRoundtableId();
  const rtKey = KEYS.roundtable(rtId);
  const createdAt = new Date().toISOString();

  await withRetry(() => {
    const fields = [
      'topic', topic,
      'participants', JSON.stringify(participantList),
      'status', 'active',
      'current_round', '0',
      'created_at', createdAt,
    ];
    if (context) fields.push('context', context);
    if (constraints) fields.push('constraints', constraints);
    if (template) fields.push('template', template);

    redis('HSET', rtKey, ...fields);
    redis('EXPIRE', rtKey, '86400'); // 24h TTL as safety net
    redis('EXPIRE', KEYS.roundtableRounds(rtId), '86400'); // rounds stream too

    // Emit event
    try {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'roundtable:created',
        'rt_id', rtId,
        'topic', topic,
        'timestamp', now(),
      );
    } catch { /* best effort */ }

    return true;
  });

  // Auto-create task-status tracker for roundtable visibility
  let trackerResult = null;
  try {
    const topicId = args.find((a, i) => args[i - 1] === '--topic-id') || '1';
    trackerResult = await ensureTaskStatusTracker(rtId, {
      title: `🏛️ RT: ${topic}`,
      topic_id: topicId,
      run_id: rtId,
      coordinator_id: 'nerey',
      agent_id: participantList[0],
    });
    // Bootstrap statuses for all roundtable participants
    for (const agent of participantList) {
      ensureBootstrappedAgentStatus(agent, {
        task_id: rtId,
        run_id: rtId,
        state: 'queued',
        step: 'roundtable: awaiting turn',
      });
    }
  } catch (err) {
    process.stderr.write(`[ocr warn] auto-tracker for roundtable ${rtId} failed: ${err.message}\n`);
  }

  const result = { ok: true, rt_id: rtId };
  if (template) result.template = template;
  if (trackerResult) result.tracker = { ok: trackerResult.ok, message_id: trackerResult.message_id };
  output(result);
}

export async function cmdRoundtableContribute(args) {
  if (!args[0] || args[0].startsWith('--')) throw argError('roundtable-contribute requires <rt_id>');
  const rtId = args[0];

  let agent = null, round = null, summary = null;
  let findings = null, recommendations = null, agrees_with = null, disagrees_with = null, questions = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1])                { agent = args[i + 1]; i++; }
    else if (args[i] === '--round' && args[i + 1])           { round = args[i + 1]; i++; }
    else if (args[i] === '--summary' && args[i + 1])         { summary = args[i + 1]; i++; }
    else if (args[i] === '--findings' && args[i + 1])        { findings = args[i + 1]; i++; }
    else if (args[i] === '--recommendations' && args[i + 1]) { recommendations = args[i + 1]; i++; }
    else if (args[i] === '--agrees_with' && args[i + 1])     { agrees_with = args[i + 1]; i++; }
    else if (args[i] === '--disagrees_with' && args[i + 1])  { disagrees_with = args[i + 1]; i++; }
    else if (args[i] === '--questions' && args[i + 1])       { questions = args[i + 1]; i++; }
  }

  if (!agent) throw argError('roundtable-contribute requires --agent');
  validateAgentId(agent, 'roundtable-contribute');
  if (!round) throw argError('roundtable-contribute requires --round');
  // P0-2: validate round is a positive integer
  const roundNum = parseInt(round, 10);
  if (isNaN(roundNum) || roundNum < 1) throw argError('round must be a positive integer');
  if (!summary) throw argError('roundtable-contribute requires --summary');

  const rtKey = KEYS.roundtable(rtId);
  const streamKey = KEYS.roundtableRounds(rtId);

  const entryId = await withRetry(async () => {
    // Check roundtable exists and validate agent
    const exists = redis('EXISTS', rtKey);
    if (exists !== '1' && exists !== 1) {
      const err = new Error(`roundtable ${rtId} not found`);
      err.isArgError = true;
      throw err;
    }

    // Check roundtable is still active
    const rtStatus = redis('HGET', rtKey, 'status');
    if (rtStatus === 'completed') {
      output({ ok: false, error: 'roundtable_closed', message: `roundtable ${rtId} is already completed` }, 1);
      return null;
    }

    // Validate agent is a participant (warning, not hard error for flexibility)
    try {
      const rawParticipants = redis('HGET', rtKey, 'participants');
      if (rawParticipants) {
        const pList = JSON.parse(rawParticipants);
        if (Array.isArray(pList) && !pList.includes(agent)) {
          // Log warning but allow — some workflows add agents dynamically
          process.stderr.write(`[ocr warn] agent "${agent}" is not in participants: ${pList.join(', ')}\n`);
        }
      }
    } catch { /* best effort validation */ }

    // Build stream fields
    const fields = [
      'agent', agent,
      'round', String(roundNum),
      'summary', summary,
    ];
    if (findings)         fields.push('findings', findings);
    if (recommendations)  fields.push('recommendations', recommendations);
    if (agrees_with)      fields.push('agrees_with', agrees_with);
    if (disagrees_with)   fields.push('disagrees_with', disagrees_with);
    if (questions)        fields.push('questions', questions);

    // Upsert: remove previous contribution from same agent+round
    try {
      const existingRaw = redisRaw(['XRANGE', streamKey, '-', '+']);
      const existing = parseXread(existingRaw);
      for (const entry of existing) {
        if (entry.agent === agent && String(entry.round) === String(roundNum)) {
          redis('XDEL', streamKey, entry.id);
        }
      }
    } catch { /* best effort — if fails, append is acceptable */ }

    // Lock the roundtable during contribute + auto-complete to prevent
    // concurrent contributions from racing on the "last participant" check.
    const rtLockKey = `openclaw:locks:roundtable:${rtId}`;
    let id;
    await withLock(rtLockKey, async () => {
      id = redis('XADD', streamKey, '*', ...fields);

      // Update current_round to MAX(current, new)
      try {
        const curRound = parseInt(redis('HGET', rtKey, 'current_round') || '0', 10);
        if (roundNum >= curRound) {
          redis('HSET', rtKey, 'current_round', String(roundNum));
        }
      } catch {
        redis('HSET', rtKey, 'current_round', String(roundNum));
      }

      // Ownership-based cleanup: last participant contribution auto-completes and cleans keys.
      tryAutoCompleteRoundtable(rtId, rtKey, streamKey);
    });

    return id;
  });

  output({ ok: true, entry_id: entryId });
}

export async function cmdRoundtableRead(args) {
  if (!args[0] || args[0].startsWith('--')) throw argError('roundtable-read requires <rt_id>');
  const rtId = args[0];

  let filterRound = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--round' && args[i + 1]) { filterRound = args[i + 1]; i++; }
  }

  const rtKey = KEYS.roundtable(rtId);
  const streamKey = KEYS.roundtableRounds(rtId);

  const result = await withRetry(() => {
    // Read metadata
    const rawMeta = redisRaw(['HGETALL', rtKey]);
    const meta = parseHgetall(rawMeta);

    if (!Object.keys(meta).length) {
      return null;
    }

    // Parse participants back to array
    if (meta.participants) {
      meta.participants = parseJson(meta.participants, meta.participants);
    }

    // Read stream
    const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
    const contributions = parseXread(rawStream);

    // Filter by round if requested
    const filtered = filterRound
      ? contributions.filter(c => String(c.round) === String(filterRound))
      : contributions;

    return { rt_id: rtId, meta, contributions: filtered };
  });

  if (!result) {
    output({ ok: false, reason: 'not_found', rt_id: rtId }, 1);
    return;
  }

  output({ ok: true, ...result });
}

export async function cmdRoundtableSynthesize(args) {
  if (!args[0] || args[0].startsWith('--')) throw argError('roundtable-synthesize requires <rt_id>');
  const rtId = args[0];

  let synthesis = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--synthesis' && args[i + 1]) { synthesis = args[i + 1]; i++; }
  }

  if (!synthesis) throw argError('roundtable-synthesize requires --synthesis');

  // Parse --force flag
  let force = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--force') { force = true; }
  }

  const rtKey = KEYS.roundtable(rtId);
  const completedAt = new Date().toISOString();

  const quorumResult = await withRetry(() => {
    // Check exists
    const exists = redis('EXISTS', rtKey);
    if (exists !== '1' && exists !== 1) {
      const err = new Error(`roundtable ${rtId} not found`);
      err.isArgError = true;
      throw err;
    }

    // Check not already completed (prevent double-synthesize)
    const curStatus = redis('HGET', rtKey, 'status');
    if (curStatus === 'completed') {
      const err = new Error(`roundtable ${rtId} already completed`);
      err.isArgError = true;
      throw err;
    }

    // Check quorum: how many participants actually contributed
    let warning = null;
    try {
      const rawParticipants = redis('HGET', rtKey, 'participants');
      if (rawParticipants) {
        const pList = JSON.parse(rawParticipants);
        if (Array.isArray(pList)) {
          const streamKey = KEYS.roundtableRounds(rtId);
          const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
          const contributions = parseXread(rawStream);
          const contributedAgents = new Set(contributions.map(c => c.agent));
          const contributed = pList.filter(p => contributedAgents.has(p)).length;

          // Hard block: minimum 2 contributors required
          if (contributed < 2) {
            output({ ok: false, error: `quorum not met: only ${contributed} of ${pList.length} participants contributed (minimum 2 required)` });
            return 'BLOCK';
          }

          // Soft block: partial quorum, require --force
          if (contributed < pList.length && !force) {
            output({ ok: false, error: `partial quorum: ${contributed} of ${pList.length} participants contributed. Use --force to synthesize anyway.` });
            return 'BLOCK';
          }

          // Warning only (with --force or full quorum)
          if (contributed < pList.length) {
            warning = `partial quorum: ${contributed} of ${pList.length} participants contributed (forced)`;
          }
        }
      }
    } catch { /* best effort quorum check */ }

    return warning;
  });

  // If quorum check blocked, abort
  if (quorumResult === 'BLOCK') return;

  const quorumWarning = quorumResult;

  // Get topic before cleanup for event emission
  let topic = '';
  try { topic = redis('HGET', rtKey, 'topic'); } catch { /* best effort */ }

  await withRetry(() => {
    // Emit event before DEL so we still have data context
    try {
      redis('XADD', KEYS.eventsStream, 'MAXLEN', '~', '10000', '*',
        'type', 'roundtable:synthesized',
        'rt_id', rtId,
        'topic', topic || '',
        'timestamp', now(),
      );
    } catch { /* best effort */ }
  });

  // Autosave history (best-effort) — must read from Redis BEFORE cleanup
  let archiveResult = { archived: false, archive_error: 'skipped' };
  try {
    const rawMeta = redisRaw(['HGETALL', rtKey]);
    const meta = parseHgetall(rawMeta);
    if (meta.participants) {
      meta.participants = parseJson(meta.participants, meta.participants);
    }
    // Inject synthesis into meta for archive (key is about to be deleted)
    meta.synthesis = synthesis;
    meta.status = 'completed';
    meta.completed_at = completedAt;

    const streamKey = KEYS.roundtableRounds(rtId);
    const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
    const contributions = parseXread(rawStream);
    archiveResult = await saveRoundtableHistory(rtId, meta, contributions, synthesis);
  } catch (err) {
    archiveResult = { archived: false, archive_error: String(err.message || err) };
  }

  // Cleanup: DEL roundtable keys after archiving
  cleanupRoundtableKeys(rtId, rtKey, KEYS.roundtableRounds(rtId), 'synthesize');

  const resultObj = { ok: true, ...archiveResult };
  if (quorumWarning) resultObj.warning = quorumWarning;

  output(resultObj);
}

export async function cmdRoundtableTally(args) {
  if (!args[0] || args[0].startsWith('--')) throw argError('roundtable-tally requires <rt_id>');
  const rtId = args[0];

  let filterRound = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--round' && args[i + 1]) { filterRound = args[i + 1]; i++; }
  }

  const rtKey = KEYS.roundtable(rtId);
  const streamKey = KEYS.roundtableRounds(rtId);

  const result = await withRetry(() => {
    const exists = redis('EXISTS', rtKey);
    if (exists !== '1' && exists !== 1) {
      const err = new Error(`roundtable ${rtId} not found`);
      err.isArgError = true;
      throw err;
    }

    const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
    const contributions = parseXread(rawStream);

    const filtered = filterRound
      ? contributions.filter(c => String(c.round) === String(filterRound))
      : contributions;

    // Build tally: for each agent mentioned in agrees_with/disagrees_with,
    // count how many times they were supported/opposed
    const tally = {};

    for (const c of filtered) {
      const voter = c.agent;
      const agreedWith = parseAgentRefs(c.agrees_with);
      const disagreedWith = parseAgentRefs(c.disagrees_with);

      for (const target of agreedWith) {
        if (!tally[target]) tally[target] = { agree_count: 0, disagree_count: 0, agreed_by: [], disagreed_by: [] };
        tally[target].agree_count++;
        if (!tally[target].agreed_by.includes(voter)) tally[target].agreed_by.push(voter);
      }

      for (const target of disagreedWith) {
        if (!tally[target]) tally[target] = { agree_count: 0, disagree_count: 0, agreed_by: [], disagreed_by: [] };
        tally[target].disagree_count++;
        if (!tally[target].disagreed_by.includes(voter)) tally[target].disagreed_by.push(voter);
      }
    }

    // Consensus
    const agents = Object.keys(tally);
    const unresolved = agents.filter(a => tally[a].disagree_count > 0);
    const hasConsensus = agents.length > 0 && !agents.some(a => tally[a].disagree_count > tally[a].agree_count);

    let maxAgree = 0, maxDisagree = 0;
    for (const a of agents) {
      if (tally[a].agree_count > maxAgree) maxAgree = tally[a].agree_count;
      if (tally[a].disagree_count > maxDisagree) maxDisagree = tally[a].disagree_count;
    }

    const strongestSupport = maxAgree > 0 ? agents.filter(a => tally[a].agree_count === maxAgree) : [];
    const strongestObjections = maxDisagree > 0 ? agents.filter(a => tally[a].disagree_count === maxDisagree) : [];

    return {
      rt_id: rtId,
      round: filterRound || 'all',
      contributions_counted: filtered.length,
      tally,
      consensus: {
        has_consensus: hasConsensus,
        strongest_support: strongestSupport,
        strongest_objections: strongestObjections,
        unresolved_agents: unresolved,
      },
    };
  });

  output({ ok: true, ...result });
}

export async function cmdRoundtableStatus(args) {
  if (!args[0] || args[0].startsWith('--')) throw argError('roundtable-status requires <rt_id>');
  const rtId = args[0];

  const rtKey = KEYS.roundtable(rtId);
  const streamKey = KEYS.roundtableRounds(rtId);

  const result = await withRetry(() => {
    // Read metadata
    const rawMeta = redisRaw(['HGETALL', rtKey]);
    const meta = parseHgetall(rawMeta);

    if (!Object.keys(meta).length) {
      return { found: false };
    }

    // Parse participants back to array
    const participants = parseJson(meta.participants, []);

    // Read stream for contribution analysis
    const rawStream = redisRaw(['XRANGE', streamKey, '-', '+']);
    const contributions = parseXread(rawStream);
    const contributedAgents = [...new Set(contributions.map(c => c.agent).filter(Boolean))];
    const pendingAgents = participants.filter(p => !contributedAgents.includes(p));

    // Build summary tally (agree/disagree counts)
    let agreeCount = 0;
    let disagreeCount = 0;
    const tallyByTarget = {};

    for (const c of contributions) {
      const agreedWith = parseAgentRefs(c.agrees_with);
      const disagreedWith = parseAgentRefs(c.disagrees_with);
      agreeCount += agreedWith.length;
      disagreeCount += disagreedWith.length;

      for (const target of agreedWith) {
        if (!tallyByTarget[target]) tallyByTarget[target] = { agree: 0, disagree: 0 };
        tallyByTarget[target].agree++;
      }
      for (const target of disagreedWith) {
        if (!tallyByTarget[target]) tallyByTarget[target] = { agree: 0, disagree: 0 };
        tallyByTarget[target].disagree++;
      }
    }

    // Strongest support/objections
    const targets = Object.keys(tallyByTarget);
    let maxAgree = 0, maxDisagree = 0;
    for (const t of targets) {
      if (tallyByTarget[t].agree > maxAgree) maxAgree = tallyByTarget[t].agree;
      if (tallyByTarget[t].disagree > maxDisagree) maxDisagree = tallyByTarget[t].disagree;
    }
    const strongestSupport = maxAgree > 0 ? targets.filter(t => tallyByTarget[t].agree === maxAgree) : [];
    const strongestObjections = maxDisagree > 0 ? targets.filter(t => tallyByTarget[t].disagree === maxDisagree) : [];
    const unresolvedAgents = targets.filter(t => tallyByTarget[t].disagree > 0);

    return {
      found: true,
      rt_id: rtId,
      topic: meta.topic || '',
      status: meta.status || 'unknown',
      created_at: meta.created_at || null,
      completed_at: meta.completed_at || null,
      current_round: parseInt(meta.current_round || '0', 10),
      participants,
      contributed_agents: contributedAgents,
      pending_agents: pendingAgents,
      contributions_count: contributions.length,
      tally_summary: {
        agree_count: agreeCount,
        disagree_count: disagreeCount,
        strongest_support: strongestSupport,
        strongest_objections: strongestObjections,
        unresolved_agents: unresolvedAgents,
      },
    };
  });

  if (!result.found) {
    output({ ok: false, reason: 'not_found', rt_id: rtId }, 1);
    return;
  }

  const { found, ...data } = result;
  output({ ok: true, ...data });
}

export async function cmdRoundtableList(args) {
  let filterStatus = null;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) { filterStatus = args[i + 1]; i++; }
    else if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1], 10) || 50; i++; }
  }

  const roundtables = await withRetry(() => {
    const results = [];
    let cursor = '0';

    do {
      const raw = redisRaw(['SCAN', cursor, 'MATCH', 'openclaw:roundtable:*', 'COUNT', '100']);
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));

      cursor = clean[0] || '0';

      for (let i = 1; i < clean.length; i++) {
        const key = clean[i];
        if (!key || key.endsWith(':rounds')) continue;

        const rtId = key.replace('openclaw:roundtable:', '');
        if (!rtId || rtId.includes(':')) continue;

        // Skip invalid roundtable IDs — valid ones start with 'rt-'
        if (!rtId.startsWith('rt-')) continue;

        try {
          const rawMeta = redisRaw(['HGETALL', key]);
          const meta = parseHgetall(rawMeta);
          if (!Object.keys(meta).length) continue;

          if (meta.participants) {
            meta.participants = parseJson(meta.participants, meta.participants);
          }

          if (filterStatus && meta.status !== filterStatus) continue;

          results.push({ rt_id: rtId, ...meta });
        } catch { /* skip broken keys */ }
      }
    } while (cursor !== '0' && results.length < limit);

    results.sort((a, b) => {
      const ta = a.created_at || '';
      const tb = b.created_at || '';
      return tb.localeCompare(ta);
    });

    return results.slice(0, limit);
  });

  output({ ok: true, count: roundtables.length, roundtables });
}
