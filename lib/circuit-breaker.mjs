/**
 * lib/circuit-breaker.mjs — File-based circuit breaker
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { infraError } from './errors.mjs';
import { KEYS } from './schema.mjs';

const CB_THRESHOLD = 5;
const CB_OPEN_MS   = 30_000;

const LOCK_FILE = KEYS.circuitFile + '.lock';
const LOCK_TIMEOUT_MS = 1000;

function withFileLock(fn) {
  const start = Date.now();
  let fd;
  while (true) {
    try {
      fd = openSync(LOCK_FILE, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        // Stale lock — force remove and retry once
        try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
        try { fd = openSync(LOCK_FILE, 'wx'); break; } catch { /* give up */ }
        break; // fallback: proceed without lock
      }
      // Busy wait ~5ms
      const deadline = Date.now() + 5;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

export function cbRead() {
  try {
    if (!existsSync(KEYS.circuitFile)) return { failures: 0, openUntil: 0 };
    return JSON.parse(readFileSync(KEYS.circuitFile, 'utf8'));
  } catch {
    return { failures: 0, openUntil: 0 };
  }
}

export function cbWrite(state) {
  try { writeFileSync(KEYS.circuitFile, JSON.stringify(state)); } catch { /* ignore */ }
}

export function cbCheck() {
  const state = cbRead();
  if (state.openUntil && Date.now() < state.openUntil) {
    throw infraError('circuit_open', `Circuit breaker open for ${Math.ceil((state.openUntil - Date.now()) / 1000)}s more`);
  }
  return state;
}

export function cbSuccess() {
  withFileLock(() => {
    cbWrite({ failures: 0, openUntil: 0 });
  });
}

export function cbFailure() {
  withFileLock(() => {
    const state = cbRead();
    state.failures = (state.failures || 0) + 1;
    if (state.failures >= CB_THRESHOLD) {
      state.openUntil = Date.now() + CB_OPEN_MS;
      process.stderr.write(`[ocr] circuit breaker OPEN for 30s after ${state.failures} failures\n`);
    }
    cbWrite(state);
  });
}
