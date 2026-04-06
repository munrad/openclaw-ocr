/**
 * commands/insights.mjs — Insight staging layer commands
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw, parseJson } from '../lib/redis.mjs';
import { KEYS, genInsightId } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';

const VALID_CONFIDENCE = ['high', 'medium', 'low'];

/**
 * Parse raw ZRANGEBYSCORE output into array of insight objects.
 * Optionally filter by source and/or confidence.
 */
function parseInsightsOutput(raw, { filterSource = null, filterConfidence = null } = {}) {
  const trimmed = raw.trim();
  const insights = [];

  if (trimmed && trimmed !== '(empty array)' && trimmed !== '(nil)' && trimmed !== 'nil') {
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
    for (const item of clean) {
      if (!item || item === '(empty array)') continue;
      const unescaped = item.replace(/\\"/g, '"');
      const parsed = parseJson(unescaped);
      if (parsed) {
        if (filterSource && parsed.source !== filterSource) continue;
        if (filterConfidence && parsed.confidence !== filterConfidence) continue;
        insights.push(parsed);
      }
    }
  }

  return insights;
}

export async function cmdQueueInsight(jsonArg) {
  if (!jsonArg) throw argError('queue-insight requires <json>');
  const payload = parseJson(jsonArg);
  if (!payload) throw argError('queue-insight: invalid JSON');
  if (!payload.text) throw argError('queue-insight: "text" field is required');
  if (!payload.source) throw argError('queue-insight: "source" field is required');

  let confidence = payload.confidence;
  if (confidence === undefined || confidence === null || confidence === '') {
    confidence = 'medium';
  } else if (typeof confidence === 'number' || (typeof confidence === 'string' && !isNaN(parseFloat(confidence)) && !VALID_CONFIDENCE.includes(confidence))) {
    // Numeric confidence (0-1): map to label
    const num = parseFloat(confidence);
    if (isNaN(num) || num < 0 || num > 1) {
      throw argError('queue-insight: numeric confidence must be between 0 and 1');
    }
    confidence = num >= 0.7 ? 'high' : num >= 0.4 ? 'medium' : 'low';
  } else if (!VALID_CONFIDENCE.includes(confidence)) {
    throw argError(`queue-insight: confidence must be one of: ${VALID_CONFIDENCE.join(', ')} or a number 0-1`);
  }

  const id = genInsightId();
  const createdAt = new Date().toISOString();
  const score = Date.now();

  const insight = {
    id,
    text: payload.text,
    source: payload.source,
    confidence,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    created_at: createdAt,
  };

  const position = await withRetry(() => {
    redis('ZADD', KEYS.INSIGHTS, String(score), JSON.stringify(insight));
    return redis('ZRANK', KEYS.INSIGHTS, JSON.stringify(insight));
  });

  output({ ok: true, insight_id: id, position: parseInt(position, 10) || 0 });
}

export async function cmdListInsights(args) {
  // Parse --limit, --source, --confidence, --promoted from args
  let limit = 50;
  let filterSource = null;
  let filterConfidence = null;
  let showPromoted = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10) || 50;
      i++;
    } else if (args[i] === '--source' && args[i + 1]) {
      filterSource = args[i + 1];
      i++;
    } else if (args[i] === '--confidence' && args[i + 1]) {
      filterConfidence = args[i + 1];
      i++;
    } else if (args[i] === '--promoted') {
      showPromoted = true;
    }
  }

  const key = showPromoted ? KEYS.INSIGHTS_PROMOTED : KEYS.INSIGHTS;
  const raw = await withRetry(() => {
    return redisRaw(['ZRANGEBYSCORE', key, '-inf', '+inf', 'LIMIT', '0', String(limit)]);
  });

  const insights = parseInsightsOutput(raw, { filterSource, filterConfidence });
  output({ ok: true, insights, count: insights.length });
}

export async function cmdPromoteInsight(insightId) {
  if (!insightId) throw argError('promote-insight requires <insight-id>');

  const result = await withRetry(() => {
    // Scan all insights to find the one with matching id
    const raw = redisRaw(['ZRANGEBYSCORE', KEYS.INSIGHTS, '-inf', '+inf', 'LIMIT', '0', '500']);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '(empty array)' || trimmed === '(nil)' || trimmed === 'nil') {
      return null;
    }

    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));

    for (const item of clean) {
      if (!item || item === '(empty array)') continue;
      const unescaped = item.replace(/\\"/g, '"');
      const parsed = parseJson(unescaped);
      if (parsed && parsed.id === insightId) {
        // Found — move to promoted set
        const promotedAt = new Date().toISOString();
        const score = Date.now();
        const promoted = { ...parsed, promoted_at: promotedAt };
        const promotedJson = JSON.stringify(promoted);

        redis('ZREM', KEYS.INSIGHTS, unescaped);
        redis('ZADD', KEYS.INSIGHTS_PROMOTED, String(score), promotedJson);
        return promoted;
      }
    }
    return null;
  });

  if (!result) {
    output({ ok: false, reason: 'not_found', insight_id: insightId }, 1);
    return;
  }

  output({ ok: true, insight_id: insightId, promoted: true });
}

export async function cmdDismissInsight(insightId) {
  if (!insightId) throw argError('dismiss-insight requires <insight-id>');

  const removed = await withRetry(() => {
    // Scan all insights to find the one with matching id
    const raw = redisRaw(['ZRANGEBYSCORE', KEYS.INSIGHTS, '-inf', '+inf', 'LIMIT', '0', '500']);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '(empty array)' || trimmed === '(nil)' || trimmed === 'nil') {
      return false;
    }

    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));

    for (const item of clean) {
      if (!item || item === '(empty array)') continue;
      const unescaped = item.replace(/\\"/g, '"');
      const parsed = parseJson(unescaped);
      if (parsed && parsed.id === insightId) {
        const res = redis('ZREM', KEYS.INSIGHTS, unescaped);
        return res === '1' || res === 1;
      }
    }
    return false;
  });

  if (!removed) {
    // Insight not in pending set — try promoted set
    const removedFromPromoted = await withRetry(() => {
      const raw = redisRaw(['ZRANGEBYSCORE', KEYS.INSIGHTS_PROMOTED, '-inf', '+inf', 'LIMIT', '0', '500']);
      const trimmed = raw.trim();
      if (!trimmed || trimmed === '(empty array)' || trimmed === '(nil)' || trimmed === 'nil') {
        return false;
      }
      const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
      const clean = lines.map(l => l.replace(/^\d+\)\s*/, '').replace(/^"(.*)"$/, '$1'));
      for (const item of clean) {
        if (!item || item === '(empty array)') continue;
        const unescaped = item.replace(/\\"/g, '"');
        const parsed = parseJson(unescaped);
        if (parsed && parsed.id === insightId) {
          // Use the exact member string as stored in Redis for ZREM
          let res = redis('ZREM', KEYS.INSIGHTS_PROMOTED, item);
          if (parseInt(res, 10) >= 1) return true;
          // Fallback: try unescaped variant
          res = redis('ZREM', KEYS.INSIGHTS_PROMOTED, unescaped);
          if (parseInt(res, 10) >= 1) return true;
          // Fallback: try re-serialized JSON (canonical form)
          res = redis('ZREM', KEYS.INSIGHTS_PROMOTED, JSON.stringify(parsed));
          return parseInt(res, 10) >= 1;
        }
      }
      return false;
    });

    if (!removedFromPromoted) {
      output({ ok: false, reason: 'not_found', insight_id: insightId }, 1);
      return;
    }

    output({ ok: true, insight_id: insightId, dismissed: true, source: 'promoted' });
    return;
  }

  output({ ok: true, insight_id: insightId, dismissed: true });
}
