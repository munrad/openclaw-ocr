/**
 * commands/costs.mjs — Per-agent cost tracking and reporting
 *
 * Reads openclaw event stream + lifecycle data to estimate costs.
 * Uses model cost table from openclaw.json for pricing.
 *
 * Commands:
 *   ocr cost-report [--today|--days N|--agent ID]
 *   ocr cost-log <json>   — record a cost event from agent run
 */
import { withRetry } from '../lib/retry.mjs';
import { redis, redisRaw } from '../lib/redis.mjs';
import { KEYS } from '../lib/schema.mjs';
import { output, argError } from '../lib/errors.mjs';

// Redis keys for cost tracking
const COST_STREAM = 'openclaw:costs:stream';
const COST_DAILY  = (date) => `openclaw:costs:daily:${date}`;

// Default model costs ($/1M tokens) — sync with openclaw.json
const MODEL_COSTS = {
  'claude-opus-4-6':       { input: 5,    output: 25,   cacheRead: 0.5 },
  'claude-sonnet-4-6':     { input: 3,    output: 15,   cacheRead: 0.3 },
  'claude-haiku-4-5':      { input: 1,    output: 5,    cacheRead: 0.1 },
  'gpt-5.4':               { input: 2.5,  output: 10,   cacheRead: 0.25 },
  'gpt-5.3-codex-spark':   { input: 0,    output: 0,    cacheRead: 0 },
  'gpt-5.2':               { input: 1.25, output: 5,    cacheRead: 0.125 },
  'glm-5':                 { input: 1,    output: 3.2,  cacheRead: 0.2 },
  'glm-4.7':               { input: 0.6,  output: 2.2,  cacheRead: 0.11 },
  'glm-4.7-flash':         { input: 0.07, output: 0.4,  cacheRead: 0 },
  'glm-4.5-flash':         { input: 0,    output: 0,    cacheRead: 0 },
  'gemini-3.1-pro-preview':{ input: 1.25, output: 10,   cacheRead: 0.3 },
  'gemini-3-flash-preview': { input: 0.15, output: 0.6, cacheRead: 0.04 },
};

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Calculate cost in USD from token counts and model name.
 */
function calcCost(model, inputTokens, outputTokens, cacheReadTokens = 0) {
  // Strip provider prefix
  const shortModel = model.replace(/^[^/]+\//, '');
  const rates = MODEL_COSTS[shortModel] || { input: 2, output: 10, cacheRead: 0.2 };

  const cost =
    (inputTokens * rates.input / 1_000_000) +
    (outputTokens * rates.output / 1_000_000) +
    (cacheReadTokens * rates.cacheRead / 1_000_000);

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal precision
}

/**
 * ocr cost-log <json>
 * Record a cost event. Called by lifecycle hooks or agent wrappers.
 *
 * Input JSON: { agent, model, inputTokens, outputTokens, cacheReadTokens?, runId? }
 */
export async function cmdCostLog(args) {
  const raw = args[0];
  if (!raw) throw argError('Usage: ocr cost-log \'{"agent":"coder","model":"claude-opus-4-6","inputTokens":5000,"outputTokens":1000}\'');

  const data = JSON.parse(raw);
  const { agent, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, runId = '' } = data;

  if (!agent || !model) throw argError('agent and model are required');

  const costUsd = calcCost(model, inputTokens, outputTokens, cacheReadTokens);
  const date = todayDate();
  const ts = Date.now();

  // Write to cost stream (capped at 50000 entries)
  await withRetry(() => {
    redis('XADD', COST_STREAM, 'MAXLEN', '~', '50000', '*',
      'agent', agent,
      'model', model,
      'input_tokens', String(inputTokens),
      'output_tokens', String(outputTokens),
      'cache_read_tokens', String(cacheReadTokens),
      'cost_usd', String(costUsd),
      'run_id', runId,
      'date', date,
      'ts', String(ts));
  });

  // Increment daily aggregates
  await withRetry(() => {
    const key = COST_DAILY(date);
    redis('HINCRBYFLOAT', key, `total`, String(costUsd));
    redis('HINCRBYFLOAT', key, `agent:${agent}`, String(costUsd));
    redis('HINCRBYFLOAT', key, `model:${model}`, String(costUsd));
    redis('HINCRBY', key, 'requests', '1');
    redis('EXPIRE', key, String(30 * 86400)); // 30 days TTL
  });

  output({ ok: true, agent, model, costUsd, date });
}

/**
 * ocr cost-report [--today|--days N|--agent AGENT_ID]
 * Aggregate cost report from daily hashes.
 */
export async function cmdCostReport(args) {
  let days = 1;
  let filterAgent = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--today') days = 1;
    else if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[++i], 10) || 1; }
    else if (args[i] === '--agent' && args[i + 1]) { filterAgent = args[++i]; }
  }

  const report = {
    period: { days, from: daysAgo(days - 1), to: todayDate() },
    totalUsd: 0,
    totalRequests: 0,
    byAgent: {},
    byModel: {},
    byDay: [],
  };

  for (let d = 0; d < days; d++) {
    const date = daysAgo(d);
    let fields = {};
    try {
      const raw = redisRaw(['HGETALL', COST_DAILY(date)]);
      const lines = raw.trim().split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i += 2) {
        fields[lines[i]] = lines[i + 1];
      }
    } catch { /* no data for this day */ }

    const dayTotal = parseFloat(fields.total || '0');
    const dayRequests = parseInt(fields.requests || '0', 10);

    const dayAgents = {};
    const dayModels = {};

    for (const [k, v] of Object.entries(fields)) {
      if (k.startsWith('agent:')) {
        const agentId = k.slice(6);
        const val = parseFloat(v);
        dayAgents[agentId] = val;
        report.byAgent[agentId] = (report.byAgent[agentId] || 0) + val;
      }
      if (k.startsWith('model:')) {
        const modelId = k.slice(6);
        const val = parseFloat(v);
        dayModels[modelId] = val;
        report.byModel[modelId] = (report.byModel[modelId] || 0) + val;
      }
    }

    report.totalUsd += dayTotal;
    report.totalRequests += dayRequests;
    report.byDay.push({ date, totalUsd: dayTotal, requests: dayRequests, agents: dayAgents });
  }

  // Round totals
  report.totalUsd = Math.round(report.totalUsd * 100) / 100;
  for (const k of Object.keys(report.byAgent)) {
    report.byAgent[k] = Math.round(report.byAgent[k] * 100) / 100;
  }
  for (const k of Object.keys(report.byModel)) {
    report.byModel[k] = Math.round(report.byModel[k] * 100) / 100;
  }

  // Filter by agent if requested
  if (filterAgent) {
    report.byAgent = { [filterAgent]: report.byAgent[filterAgent] || 0 };
    report.byDay = report.byDay.map(d => ({
      ...d,
      agents: { [filterAgent]: d.agents[filterAgent] || 0 },
    }));
  }

  // Sort agents by cost descending
  report.byAgent = Object.fromEntries(
    Object.entries(report.byAgent).sort(([, a], [, b]) => b - a)
  );

  output({ ok: true, ...report });
}
