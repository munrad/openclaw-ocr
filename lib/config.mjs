/**
 * lib/config.mjs — Redis connection config
 */
import { readFileSync } from 'node:fs';

export function loadConfig() {
  let password = process.env.REDIS_PASSWORD || '';
  let db = String(process.env.REDIS_DB || '0').trim();
  if (!password) {
    try {
      password = readFileSync('/run/secrets/redis_password', 'utf8').trim();
    } catch {
      // no secret file — will fail on auth if password required
    }
  }
  if (!/^\d+$/.test(db)) db = '0';
  return {
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || '6379',
    password,
    db,
  };
}

export const CONFIG = loadConfig();
