import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { test } from 'node:test';
import { getDefaultTelegramChatId, getDefaultTelegramTopicId } from '../lib/config.mjs';
import {
  TEST_TELEGRAM_CHAT_ID,
  TEST_TELEGRAM_GENERAL_TOPIC_ID,
  TEST_TELEGRAM_LAZY_BOT_TOKEN,
} from './helpers/telegram-test-config.mjs';

test('tgApiSafe reads OPENCLAW_TELEGRAM_BOT_TOKEN lazily at call time', async () => {
  const previousToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
  delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;

  const { tgApiSafe } = await import('../commands/task-status.mjs');

  let capturedPath = '';
  const originalRequest = https.request;
  https.request = (options, onResponse) => {
    capturedPath = String(options?.path || '');

    class FakeReq extends EventEmitter {
      write() {}
      end() {
        const res = new EventEmitter();
        setImmediate(() => {
          onResponse?.(res);
          res.emit('data', JSON.stringify({ ok: true, result: { message_id: 123 } }));
          res.emit('end');
        });
      }
      destroy(err) {
        if (err) this.emit('error', err);
      }
    }

    return new FakeReq();
  };

  try {
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = TEST_TELEGRAM_LAZY_BOT_TOKEN;
    const result = await tgApiSafe('sendMessage', { chat_id: '1', text: 'hello' }, 1, { timeoutMs: 300 });
    assert.equal(result.ok, true);
    assert.equal(capturedPath, `/bot${TEST_TELEGRAM_LAZY_BOT_TOKEN}/sendMessage`);
  } finally {
    https.request = originalRequest;
    if (previousToken === undefined) delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
    else process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = previousToken;
  }
});

test('telegram chat/topic defaults read lazily from env at call time', () => {
  const previousChatId = process.env.OPENCLAW_TELEGRAM_CHAT_ID;
  const previousTopicId = process.env.OPENCLAW_TELEGRAM_TOPIC_ID;
  delete process.env.OPENCLAW_TELEGRAM_CHAT_ID;
  delete process.env.OPENCLAW_TELEGRAM_TOPIC_ID;

  try {
    process.env.OPENCLAW_TELEGRAM_CHAT_ID = TEST_TELEGRAM_CHAT_ID;
    process.env.OPENCLAW_TELEGRAM_TOPIC_ID = TEST_TELEGRAM_GENERAL_TOPIC_ID;
    assert.equal(getDefaultTelegramChatId(), TEST_TELEGRAM_CHAT_ID);
    assert.equal(getDefaultTelegramTopicId(), TEST_TELEGRAM_GENERAL_TOPIC_ID);
  } finally {
    if (previousChatId === undefined) delete process.env.OPENCLAW_TELEGRAM_CHAT_ID;
    else process.env.OPENCLAW_TELEGRAM_CHAT_ID = previousChatId;
    if (previousTopicId === undefined) delete process.env.OPENCLAW_TELEGRAM_TOPIC_ID;
    else process.env.OPENCLAW_TELEGRAM_TOPIC_ID = previousTopicId;
  }
});
