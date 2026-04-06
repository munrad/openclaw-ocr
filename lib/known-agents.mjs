/**
 * lib/known-agents.mjs — Agent-id validation with did-you-mean suggestions
 */
import { KNOWN_AGENTS as AGENTS_LIST } from './schema.mjs';

export const KNOWN_AGENTS = new Set(AGENTS_LIST);

/**
 * Simple Levenshtein distance (no dependencies, ~10 lines)
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Validate agent-id against known agents list.
 * Prints a WARNING to stderr if unknown — does NOT throw (backward compat).
 * @param {string|undefined} agentId
 * @param {string} [command] — command name for context (unused, reserved)
 */
export function validateAgentId(agentId, command) {
  if (!agentId) return;
  if (KNOWN_AGENTS.has(agentId)) return;

  const suggestions = [...KNOWN_AGENTS].filter(a =>
    a.includes(agentId) || agentId.includes(a) || levenshtein(a, agentId) <= 2
  );
  const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
  process.stderr.write(`Warning: unknown agent-id "${agentId}".${hint}\n`);
}
