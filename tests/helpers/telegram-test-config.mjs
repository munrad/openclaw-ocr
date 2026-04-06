export const TEST_TELEGRAM_BOT_TOKEN = '1:fake';
export const TEST_TELEGRAM_LAZY_BOT_TOKEN = 'lazy-token';
export const TEST_TELEGRAM_CHAT_ID = '-1003891295903';
export const TEST_TELEGRAM_GENERAL_TOPIC_ID = '1';
export const TEST_TELEGRAM_TOPIC_ID = '72';
export const TEST_TELEGRAM_CHANNEL_TARGET = `channel:${TEST_TELEGRAM_CHAT_ID}`;

export function ensureTestTelegramEnv(env = process.env, {
  token = TEST_TELEGRAM_BOT_TOKEN,
  chatId = TEST_TELEGRAM_CHAT_ID,
  topicId = TEST_TELEGRAM_GENERAL_TOPIC_ID,
} = {}) {
  if (!env.OPENCLAW_TELEGRAM_BOT_TOKEN) env.OPENCLAW_TELEGRAM_BOT_TOKEN = token;
  if (!env.OPENCLAW_TELEGRAM_CHAT_ID) env.OPENCLAW_TELEGRAM_CHAT_ID = chatId;
  if (!env.OPENCLAW_TELEGRAM_TOPIC_ID) env.OPENCLAW_TELEGRAM_TOPIC_ID = topicId;
  return env;
}
