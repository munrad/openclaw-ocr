/**
 * lib/config.mjs — Redis + Telegram runtime config
 */
import { readFileSync } from 'node:fs';

const REDIS_PASSWORD_SECRET_PATH = '/run/secrets/redis_password';
const TELEGRAM_BOT_TOKEN_SECRET_PATH = '/run/secrets/telegram_bot_token';
const TELEGRAM_CHAT_ID_SECRET_PATH = '/run/secrets/telegram_chat_id';
const TELEGRAM_TOPIC_ID_SECRET_PATH = '/run/secrets/telegram_topic_id';
const DEFAULT_TELEGRAM_TOPIC_ID = '1';

export function readOptionalSecret(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export function loadConfig() {
  let password = process.env.REDIS_PASSWORD || '';
  let db = String(process.env.REDIS_DB || '0').trim();
  if (!password) {
    password = readOptionalSecret(REDIS_PASSWORD_SECRET_PATH);
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

export function getTelegramRuntimeConfig() {
  const botToken = String(
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
    || readOptionalSecret(TELEGRAM_BOT_TOKEN_SECRET_PATH)
    || '',
  ).trim();
  const defaultChatId = String(
    process.env.OPENCLAW_TELEGRAM_CHAT_ID
    || readOptionalSecret(TELEGRAM_CHAT_ID_SECRET_PATH)
    || '',
  ).trim();
  const defaultTopicId = String(
    process.env.OPENCLAW_TELEGRAM_TOPIC_ID
    || readOptionalSecret(TELEGRAM_TOPIC_ID_SECRET_PATH)
    || DEFAULT_TELEGRAM_TOPIC_ID,
  ).trim() || DEFAULT_TELEGRAM_TOPIC_ID;

  return {
    botToken,
    defaultChatId,
    defaultTopicId,
    secretPaths: {
      botToken: TELEGRAM_BOT_TOKEN_SECRET_PATH,
      chatId: TELEGRAM_CHAT_ID_SECRET_PATH,
      topicId: TELEGRAM_TOPIC_ID_SECRET_PATH,
    },
  };
}

export function getTelegramBotToken() {
  return getTelegramRuntimeConfig().botToken;
}

export function getDefaultTelegramChatId() {
  return getTelegramRuntimeConfig().defaultChatId;
}

export function getDefaultTelegramTopicId() {
  return getTelegramRuntimeConfig().defaultTopicId;
}
