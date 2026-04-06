/**
 * commands/router.mjs — Deterministic task routing engine (Phase A)
 *
 * Routes incoming tasks to the correct agent + pipeline
 * based on keyword matching and metadata.type hints.
 *
 * Usage: ocr route-task <json>
 *
 * Input JSON:
 *   { "text": "...", "source": "telegram|cron|event|manual",
 *     "metadata": { "type": "feature|incident|..." } }
 *
 * Output:
 *   { "ok": true, "route": { primary_agent, pipeline, type, confidence, reasons, needs_roundtable }, "text": "..." }
 */
import { output, argError } from '../lib/errors.mjs';
import { parseJson, redisRaw, parseHgetall } from '../lib/redis.mjs';
import { KEYS } from '../lib/schema.mjs';

// ─── Routing Rules ───────────────────────────────────────────────────────────

const ROUTING_RULES = {
  'feature':  { primary: 'planner',       pipeline: 'feature_delivery',  keywords: ['фича', 'feature', 'добавить', 'реализовать', 'создать', 'новый функционал', 'дизайн'] },
  'incident': { primary: 'monitor',       pipeline: 'incident_response', keywords: ['упал', 'не работает', 'ошибка', 'error', 'down', 'сбой', 'incident', '502', '503', 'timeout', 'crash', 'outage', 'broken', 'failing', 'degraded', 'unreachable', 'connection refused'] },
  'security': { primary: 'devops',        pipeline: 'security_fix',      keywords: ['security', 'уязвимость', 'vulnerability', 'безопасность', 'exploit'] },
  'research': { primary: 'ai-researcher', pipeline: 'research_to_build', keywords: ['исследовать', 'research', 'модель', 'AI', 'LLM', 'ML', 'ресёрч', 'изучить', 'сравнить', 'альтернативы', 'prompt', 'agent', 'RAG', 'MCP', 'embeddings', 'eval', 'fine-tune', 'context window', 'inference', 'benchmark', 'трейд-офф', 'сравнение моделей', 'best practice', 'архитектурное решение', 'выбор между'] },
  'docs':     { primary: 'writer',        pipeline: 'documentation',     keywords: ['документация', 'docs', 'README', 'описать', 'задокументировать'] },
  'digest':   { primary: 'flash',         pipeline: 'digest',            keywords: ['дайджест', 'сводка', 'digest', 'summary', 'утренний дайджест', 'вечерний дайджест'] },
  'health':   { primary: 'health',        pipeline: 'health_check',      keywords: ['еда', 'калории', 'КБЖУ', 'питание', 'food', 'meal', 'съел', 'завтрак', 'обед', 'ужин', 'перекус', 'курица', 'рис', 'белок', 'углевод', 'жир', 'грамм', 'порция'] },
  'lookup':   { primary: 'flash',         pipeline: null,                keywords: ['найди', 'поищи', 'lookup', 'quick', 'brief', 'tl;dr', 'what is', 'latest', 'дай кратко', 'быстро найди', 'что такое', 'объясни', 'ссылка на', 'покажи', 'кратко сведи', 'новости', 'сводка', 'расскажи'] },
  'verify':   { primary: 'fact-checker',   pipeline: null,                keywords: ['verify', 'fact-check', 'source', 'citation', 'prove', 'confirm', 'stats', 'benchmark', 'date', 'правда ли', 'проверь факт', 'это точно', 'проверь данные', 'верно ли'] },
  'monitor':  { primary: 'monitor',       pipeline: 'incident_response', keywords: ['monitor', 'alert', 'lag', 'stale', 'anomaly', 'trend', 'outage', 'queue', 'backlog', 'heartbeat', 'деградация', 'алерт', 'зависло', 'сколько стоит', 'токены', 'расход', 'потребление', 'quota'] },
  'review':   { primary: 'reviewer',      pipeline: 'code_review',       keywords: ['review', 'ревью', 'проверь код', 'code review', 'audit', 'security review', 'code smell', 'anti-pattern', 'infra review', 'мердж', 'PR', 'pull request', 'код готов'] },
  'planning': { primary: 'planner',       pipeline: null,                keywords: ['план', 'backlog', 'приоритеты', 'roadmap', 'спланируй'] },
  'code':     { primary: 'coder',         pipeline: null,                keywords: ['напиши код', 'написать код', 'баг', 'фикс', 'рефакторинг', 'implement', 'fix', 'bug', 'закодить', 'запилить', 'исправь', 'исправить', 'починить', 'почини', 'пофикси', 'debug', 'тест', 'тесты', 'парсер', 'middleware', 'endpoint', 'API', 'unit test', 'test', 'tests', 'write code', 'coding', 'function', 'module', 'class', 'TypeScript', 'JavaScript', 'Python', 'refactor', 'memory leak', 'performance', 'optimize'] },
  'infra':    { primary: 'devops',        pipeline: null,                keywords: ['docker', 'deploy', 'CI', 'nginx', 'traefik', 'swarm', 'инфра', 'сервер', 'deployment', 'infrastructure', 'server', 'container', 'service', 'pipeline', 'build', 'release', 'rollback', 'scale', 'network', 'firewall', 'DNS', 'SSL', 'TLS', 'certificate', 'volume', 'backup', 'restore', 'migrate'] },
  'proof_loop': { primary: 'task-spec-freezer', pipeline: 'proof_loop', keywords: ['proof-loop', 'substantial', 'refactor', 'migration', 'proof'] },
};

// Agent capabilities and model tiers
// tier: 1=fastest (Haiku/GPT-5.3), 2=balanced (Sonnet), 3=deep (Opus/GPT-5.4)
export const AGENT_CAPABILITIES = {
  'coder':         { tier: 3, specialties: ['code', 'refactor', 'debug', 'implement'], model: 'Opus' },
  'devops':        { tier: 2, specialties: ['infra', 'docker', 'ci', 'security', 'deploy'], model: 'Sonnet' },
  'tester':        { tier: 3, specialties: ['test', 'validation', 'qa', 'challenge'], model: 'GPT-5.4' },
  'reviewer':      { tier: 2, specialties: ['review', 'patterns', 'architecture', 'audit'], model: 'Sonnet' },
  'writer':        { tier: 2, specialties: ['docs', 'readme', 'synthesis', 'text'], model: 'Sonnet' },
  'planner':       { tier: 3, specialties: ['planning', 'backlog', 'priorities', 'roadmap'], model: 'GPT-5.4' },
  'monitor':       { tier: 1, specialties: ['monitoring', 'trends', 'alerts'], model: 'Haiku' },
  'flash':         { tier: 1, specialties: ['search', 'lookup', 'summary', 'quick'], model: 'GPT-5.3' },
  'health':        { tier: 2, specialties: ['nutrition', 'health', 'food', 'calories'], model: 'Sonnet' },
  'ai-researcher': { tier: 3, specialties: ['ai', 'ml', 'models', 'research', 'papers'], model: 'Opus' },
  'fact-checker':  { tier: 1, specialties: ['facts', 'verification', 'evidence'], model: 'Haiku' },
  'task-spec-freezer': { tier: 2, specialties: ['spec', 'freeze', 'acceptance'], model: 'Sonnet' },
  'task-builder':      { tier: 3, specialties: ['build', 'implement', 'construct'], model: 'Opus' },
  'task-verifier':     { tier: 2, specialties: ['verify', 'evidence', 'judge'], model: 'Sonnet' },
  'task-fixer':        { tier: 2, specialties: ['fix', 'patch', 'smallest-diff'], model: 'Sonnet' },
};

// Complexity indicators in text
const COMPLEXITY_KEYWORDS = {
  high: ['архитектура', 'architecture', 'рефакторинг', 'refactor', 'миграция', 'migration', 'redesign', 'система', 'system', 'сложный', 'complex', 'глубокий', 'deep', 'анализ', 'analysis', 'оптимизация', 'optimization'],
  low: ['быстро', 'quick', 'простой', 'simple', 'найди', 'lookup', 'статус', 'status', 'покажи', 'show', 'проверь', 'check'],
};

/**
 * Estimate task complexity from text.
 * Returns 'high', 'medium', or 'low'.
 */
function estimateComplexity(text) {
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,.!?;:()[\]{}"'`—–-]+/).filter(w => w.length > 0);
  const stems = words.map(stem);
  let highScore = 0;
  let lowScore = 0;

  for (const kw of COMPLEXITY_KEYWORDS.high) {
    if (matchesKeyword(lower, words, stems, kw)) highScore++;
  }
  for (const kw of COMPLEXITY_KEYWORDS.low) {
    if (matchesKeyword(lower, words, stems, kw)) lowScore++;
  }

  // Length also signals complexity
  if (text.length > 500) highScore++;
  if (text.length < 50) lowScore++;

  if (highScore > lowScore) return 'high';
  if (lowScore > highScore) return 'low';
  return 'medium';
}

/**
 * Check if agent is available (not working/blocked).
 * Returns { available, state, updated_at }.
 */
function checkAgentAvailability(agentId) {
  try {
    const raw = redisRaw(['HGETALL', KEYS.agentStatus(agentId)]);
    const status = parseHgetall(raw);
    const state = status.state || 'idle';
    const available = !['working', 'blocked', 'waiting'].includes(state);
    return { available, state, updated_at: status.updated_at };
  } catch {
    return { available: true, state: 'unknown' };
  }
}

/**
 * Select best agent considering availability, complexity, and capability.
 * For complex tasks — prefer higher-tier agents.
 * For simple tasks — prefer faster agents.
 * If primary is busy — find best alternative.
 */
function selectBestAgent(primaryAgent, taskType, complexity) {
  const primary = checkAgentAvailability(primaryAgent);

  // Primary available — use it
  if (primary.available) {
    return {
      agent: primaryAgent,
      reason: 'primary_available',
      complexity,
      model: AGENT_CAPABILITIES[primaryAgent]?.model || 'unknown',
    };
  }

  // Primary busy — find alternative
  const FALLBACKS = {
    'code':     ['devops'],
    'feature':  ['coder', 'ai-researcher'],
    'incident': ['devops', 'coder'],
    'security': ['coder', 'reviewer'],
    'research': ['coder', 'planner'],
    'docs':     ['planner', 'reviewer'],
    'digest':   ['monitor', 'writer'],
    'health':   ['fact-checker'],
    'lookup':   ['monitor', 'fact-checker'],
    'review':   ['coder', 'tester'],
    'planning': ['ai-researcher', 'reviewer'],
    'infra':    ['coder', 'monitor'],
    'verify':   ['flash', 'ai-researcher'],
    'monitor':  ['devops', 'flash'],
  };

  const fallbacks = FALLBACKS[taskType] || [];

  // For complex tasks, prefer higher-tier fallbacks
  const sortedFallbacks = complexity === 'high'
    ? [...fallbacks].sort((a, b) => (AGENT_CAPABILITIES[b]?.tier || 0) - (AGENT_CAPABILITIES[a]?.tier || 0))
    : fallbacks;

  for (const fb of sortedFallbacks) {
    const status = checkAgentAvailability(fb);
    if (status.available) {
      return {
        agent: fb,
        reason: `fallback (${primaryAgent} is ${primary.state})`,
        complexity,
        model: AGENT_CAPABILITIES[fb]?.model || 'unknown',
      };
    }
  }

  // All busy — still return primary (it will queue)
  return {
    agent: primaryAgent,
    reason: `all_busy (queued for ${primaryAgent})`,
    complexity,
    model: AGENT_CAPABILITIES[primaryAgent]?.model || 'unknown',
  };
}

// Keywords that force roundtable regardless of confidence
const ROUNDTABLE_KEYWORDS = ['архитектура', 'trade-off', 'выбор', 'сравнить'];

/**
 * Simple Russian/English stem extraction.
 * Strips common suffixes to allow fuzzy keyword matching.
 * E.g., "реализуй" → "реализ", "реализовать" → "реализ"
 */
function stem(word) {
  const w = word.toLowerCase();
  // Russian verb/noun suffixes (ordered longest first)
  const suffixes = [
    'ировать', 'овать', 'ивать', 'ывать', 'евать',
    'нуть', 'ать', 'ять', 'еть', 'ить', 'оть', 'уть',
    'ует', 'ёт', 'ет', 'ит', 'ят', 'ут', 'ют',
    'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее',
    'tion', 'sion', 'ment', 'ness', 'able', 'ible',
    'ing', 'ize', 'ise', 'ful', 'ous', 'ive',
    'ам', 'ям', 'ом', 'ем', 'ах', 'ях', 'ов', 'ев', 'ей',
    'ую', 'юю', 'ую',
    'ки', 'ка', 'ку', 'ке', 'ок',
    'ы', 'и', 'а', 'я', 'у', 'ю', 'е', 'о',
    'й', 'ь',
    's', 'ed', 'er', 'ly',
  ];
  for (const suf of suffixes) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      return w.slice(0, -suf.length);
    }
  }
  return w;
}

/**
 * Check if text contains a keyword, using both exact and stem-based matching.
 */
function matchesKeyword(textLower, textWords, textStems, keyword) {
  const kwLower = keyword.toLowerCase();
  // For short keywords (≤3 chars), require word-boundary match to avoid false positives
  // e.g., "PR" should not match "practice", "AI" should not match "wait"
  if (kwLower.length <= 3 && !kwLower.includes(' ')) {
    const re = new RegExp(`(?:^|[\\s,.!?;:()\\[\\]{}"'\`—–\\-])${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s,.!?;:()\\[\\]{}"'\`—–\\-#])`, 'i');
    if (re.test(textLower)) return true;
    // Also check word list for exact match
    return textWords.some(w => w === kwLower);
  }
  // Exact substring match first (handles multi-word keywords like "code review")
  if (textLower.includes(kwLower)) return true;
  // Stem-based match for single words
  if (!kwLower.includes(' ')) {
    const kwStem = stem(kwLower);
    if (kwStem.length >= 3) {
      return textStems.some(s => {
        if (s.length < 3) return false; // skip very short stems like "с", "на"
        if (s === kwStem) return true;
        // Prefix matching: require at least 4 chars overlap to avoid false positives
        // e.g., "дай" should NOT match "дайджест"
        if (s.length >= 4 && kwStem.length >= 4) {
          return s.startsWith(kwStem) || kwStem.startsWith(s);
        }
        return false;
      });
    }
  }
  return false;
}

const ROUNDTABLE_CONFIDENCE_THRESHOLD = 0.40;
const ROUNDTABLE_MULTI_TYPE_THRESHOLD = 3;

// ─── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Score each type against the input text.
 * Returns array of { type, score, reasons } sorted by score desc.
 */
function scoreTypes(text, explicitType) {
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,.!?;:()[\]{}"'`—–-]+/).filter(w => w.length > 0);
  const stems = words.map(stem);
  const scores = [];

  for (const [type, rule] of Object.entries(ROUTING_RULES)) {
    let score = 0;
    const reasons = [];

    // Exact metadata.type match
    if (explicitType === type) {
      score += 0.90;
      reasons.push(`metadata.type: ${type}`);
    }

    // Keyword matching (exact + stem-based)
    let matchCount = 0;
    for (const kw of rule.keywords) {
      if (matchesKeyword(lower, words, stems, kw)) {
        matchCount++;
        reasons.push(`keyword: ${kw}`);
      }
    }

    if (matchCount > 0) {
      // Each keyword match adds weight:
      // 1st match: +0.50 (strong signal), each additional: +0.10
      // Cap keyword contribution at 0.80
      score += Math.min(0.50 + (matchCount - 1) * 0.10, 0.80);
    }

    if (score > 0) {
      scores.push({ type, score, reasons, rule });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * Determine if roundtable is needed.
 */
function needsRoundtable(text, scores, topScore) {
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,.!?;:()[\]{}"'`—–-]+/).filter(w => w.length > 0);
  const stems = words.map(stem);

  // Rule 1: 3+ different types matched
  if (scores.length >= ROUNDTABLE_MULTI_TYPE_THRESHOLD) {
    return true;
  }

  // Rule 2: Low confidence
  if (topScore < ROUNDTABLE_CONFIDENCE_THRESHOLD) {
    return true;
  }

  // Rule 3: Roundtable-forcing keywords (with stem matching)
  for (const kw of ROUNDTABLE_KEYWORDS) {
    if (matchesKeyword(lower, words, stems, kw)) {
      return true;
    }
  }

  return false;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export async function cmdRouteTask(args) {
  const jsonArg = args[0];
  if (!jsonArg) throw argError('route-task requires <json>');

  const task = parseJson(jsonArg);
  if (!task) throw argError('route-task: invalid JSON');
  if (!task.text) throw argError('route-task: "text" field is required');

  const source = task.source || 'manual';
  const explicitType = task.metadata?.type || null;

  // Score all types
  const scores = scoreTypes(task.text, explicitType);

  if (scores.length === 0) {
    // No match at all — default to flash for lookup
    const complexity = estimateComplexity(task.text);
    const selection = selectBestAgent('flash', 'lookup', complexity);
    output({
      ok: true,
      route: {
        primary_agent: selection.agent,
        pipeline: null,
        type: 'lookup',
        confidence: 0.30,
        complexity,
        model: selection.model,
        selection_reason: selection.reason,
        reasons: ['no keyword match, defaulting to flash'],
        needs_roundtable: true,
      },
      text: `🟡 → ${selection.agent} [${selection.model}] (lookup, 30%, ${complexity}) — low confidence, roundtable recommended`,
    });
    return;
  }

  const top = scores[0];
  let confidence = Math.min(top.score, 1.0);

  // Penalize if multiple domains matched (ambiguity)
  // Only penalize if second-best is very close (within 85% of top)
  if (scores.length >= 2) {
    const secondScore = scores[1].score;
    if (secondScore > 0 && (secondScore / confidence) > 0.85) {
      confidence *= 0.90;
    }
  }

  // Round to 2 decimal places
  confidence = Math.round(confidence * 100) / 100;

  // If ambiguous (low confidence + multiple matches):
  // Only route to planner if top score is TRULY ambiguous (second is within 80% of top).
  // If top clearly leads, trust it even at lower confidence.
  if (confidence < ROUNDTABLE_CONFIDENCE_THRESHOLD && scores.length >= 2) {
    const secondScore = scores[1].score;
    const topLeadsClearly = top.score > 0 && (secondScore / top.score) < 0.8;

    // If top clearly leads OR it's a specific actionable type, trust it
    const actionableTypes = ['code', 'lookup', 'health', 'review', 'verify', 'monitor', 'infra'];
    const isActionable = actionableTypes.includes(top.type);

    if (!topLeadsClearly && !isActionable) {
      const complexity = estimateComplexity(task.text);
      const plannerSelection = selectBestAgent('planner', 'planning', complexity);
      output({
        ok: true,
        route: {
          primary_agent: plannerSelection.agent,
          original_primary: top.rule.primary,
          pipeline: null,
          type: 'ambiguous',
          confidence,
          complexity,
          model: plannerSelection.model,
          selection_reason: `ambiguous routing (${scores.length} types matched, confidence ${confidence})`,
          reasons: [...top.reasons, `ambiguous: also matched ${scores.slice(1).map(s => s.type).join(', ')}`],
          needs_roundtable: true,
        },
        text: `🟡 → ${plannerSelection.agent} [${plannerSelection.model}] (ambiguous, ${Math.round(confidence * 100)}%, ${complexity}) — low confidence, roundtable recommended`,
      });
      return;
    }
    // Otherwise fall through to normal routing with the top match
  }

  const roundtable = needsRoundtable(task.text, scores, confidence);

  // Estimate complexity
  const complexity = estimateComplexity(task.text);

  // Select best available agent
  const selection = selectBestAgent(top.rule.primary, top.type, complexity);

  const route = {
    primary_agent: selection.agent,
    original_primary: selection.agent !== top.rule.primary ? top.rule.primary : undefined,
    pipeline: top.rule.pipeline,
    type: top.type,
    confidence,
    complexity,
    model: selection.model,
    selection_reason: selection.reason,
    reasons: top.reasons,
    needs_roundtable: roundtable,
  };

  // spawn_sub_agents support
  if (task.metadata?.spawn_sub_agents) {
    route.can_spawn = true;
    if (top.rule.pipeline) {
      const tpl = top.rule.pipeline;
      route.suggested_sub_agents = ROUTING_RULES[top.type]?.keywords ? [] : [];
      // Suggest pipeline steps as sub-agents
      try {
        const pipelineSteps = {
          feature_delivery: ['planner', 'coder', 'tester', 'reviewer'],
          incident_response: ['monitor', 'devops', 'coder', 'tester'],
          security_fix: ['devops', 'coder', 'tester', 'reviewer'],
          research_to_build: ['ai-researcher', 'coder', 'tester'],
          documentation: ['writer', 'fact-checker', 'reviewer'],
          code_review: ['coder', 'reviewer'],
          proof_loop: ['task-spec-freezer', 'task-builder', 'task-verifier', 'task-fixer'],
        };
        route.suggested_sub_agents = pipelineSteps[tpl] || [];
      } catch { /* best effort */ }
    }
  }

  // Build human-readable text
  const pipelineText = route.pipeline ? ` via ${route.pipeline}` : '';
  const rtText = roundtable ? ' ⚠️ roundtable recommended' : '';
  const complexityEmoji = complexity === 'high' ? '🔴' : complexity === 'medium' ? '🟡' : '🟢';
  const fallbackText = route.original_primary ? ` (fallback from ${route.original_primary})` : '';
  const text = `${complexityEmoji} → ${route.primary_agent} [${route.model}] (${route.type}, ${Math.round(confidence * 100)}%, ${complexity})${pipelineText}${fallbackText}${rtText}`;

  output({ ok: true, route, text });
}
