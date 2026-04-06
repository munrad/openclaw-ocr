import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { test } from 'node:test';

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
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = 'lazy-token';
    const result = await tgApiSafe('sendMessage', { chat_id: '1', text: 'hello' }, 1, { timeoutMs: 300 });
    assert.equal(result.ok, true);
    assert.equal(capturedPath, '/botlazy-token/sendMessage');
  } finally {
    https.request = originalRequest;
    if (previousToken === undefined) delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
    else process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = previousToken;
  }
});
