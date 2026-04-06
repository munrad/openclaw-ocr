/**
 * lib/retry.mjs — Retry logic with exponential backoff
 */
import { cbCheck, cbSuccess, cbFailure } from './circuit-breaker.mjs';

const RETRY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 5000,
};

const RETRYABLE = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'LOADING', 'BUSY'];

export function isRetryable(err) {
  const msg = String(err.message || err);
  return RETRYABLE.some(code => msg.includes(code));
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry(fn) {
  cbCheck(); // throws if circuit open
  let lastErr;
  for (let attempt = 0; attempt <= RETRY.maxRetries; attempt++) {
    try {
      const result = await fn();
      cbSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      // Don't retry business errors or infra errors that aren't transient
      if (!isRetryable(err) || attempt === RETRY.maxRetries) {
        if (isRetryable(err)) cbFailure();
        throw err;
      }
      cbFailure();
      const delay = Math.min(RETRY.baseDelayMs * Math.pow(2, attempt), RETRY.maxDelayMs);
      process.stderr.write(`[ocr] retry ${attempt + 1}/${RETRY.maxRetries} in ${delay}ms: ${err.message}\n`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
