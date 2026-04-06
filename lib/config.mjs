/**
 * lib/config.mjs — Redis connection config
 */
import { readFileSync } from 'node:fs';

export function loadConfig() {
  let password = process.env.REDIS_PASSWORD || '';
  if (!password) {
    try {
      password = readFileSync('/run/secrets/redis_password', 'utf8').trim();
    } catch {
      // no secret file — will fail on auth if password required
    }
  }
  return {
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || '6379',
    password,
  };
}

export const CONFIG = loadConfig();
