import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { classifyTransaction, parseClassifyBody, registerClassifyRoute } from '../src/classify/groq.ts';

const validBody = {
  merchant: 'Cafe Nero',
  amount_minor: 450,
  channel: 'sms',
  message: 'INR 4.50 spent at Cafe Nero',
  allowed_categories: [
    { id: 'food', label: 'Food' },
    { id: 'travel', label: 'Travel' }
  ]
};

async function classifyApp(opts = {}) {
  const app = Fastify({ logger: false });
  registerClassifyRoute(app, {
    groqApiKey: opts.groqApiKey ?? null,
    classify: opts.classify,
    authenticate: opts.authenticate ?? (async (request) => {
      request.userId = 'user-1';
    })
  });
  return app;
}

async function classifyPost(app, payload, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/classify/transaction',
    headers,
    payload
  });
}

test('parseClassifyBody rejects a missing allowed_categories array', () => {
  assert.throws(() => parseClassifyBody({ ...validBody, allowed_categories: undefined }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody({ merchant: 'x' }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody({ ...validBody, allowed_categories: 'food' }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody(null), /allowed_categories is required/);
});

test('parseClassifyBody accepts a valid body', () => {
  assert.deepEqual(parseClassifyBody(validBody), validBody);
});

test('POST /v1/classify/transaction is 204 when the groq key is missing', async () => {
  const app = await classifyApp({
    groqApiKey: null,
    classify: async () => {
      throw new Error('should not call Groq');
    }
  });
  try {
    const res = await classifyPost(app, validBody);
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, '');
  } finally {
    await app.close();
  }
});

test('POST /v1/classify/transaction is 204 when allowed_categories is empty', async () => {
  const app = await classifyApp({
    groqApiKey: 'gsk_test',
    classify: async () => {
      throw new Error('should not call Groq for an empty list');
    }
  });
  try {
    const res = await classifyPost(app, { ...validBody, allowed_categories: [] });
    assert.equal(res.statusCode, 204);
  } finally {
    await app.close();
  }
});

test('POST /v1/classify/transaction is 400 when allowed_categories is missing', async () => {
  const app = await classifyApp({ groqApiKey: 'gsk_test' });
  try {
    const missing = await classifyPost(app, { merchant: 'x', amount_minor: 1, channel: 'sms', message: 'hi' });
    const notArray = await classifyPost(app, { ...validBody, allowed_categories: 'food' });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'invalid_request');
    assert.equal(notArray.statusCode, 400);
    assert.equal(notArray.json().error.code, 'invalid_request');
  } finally {
    await app.close();
  }
});

test('POST /v1/classify/transaction is 200 when the classifier returns a listed id', async () => {
  const app = await classifyApp({
    groqApiKey: 'gsk_test',
    classify: async () => ({ category_id: 'food', confidence: 0.91 })
  });
  try {
    const res = await classifyPost(app, validBody);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { category_id: 'food', confidence: 0.91 });
  } finally {
    await app.close();
  }
});

test('POST /v1/classify/transaction is 204 when the classifier misses or invents an id', async () => {
  const missed = await classifyApp({ groqApiKey: 'gsk_test', classify: async () => null });
  const unknown = await classifyApp({
    groqApiKey: 'gsk_test',
    classify: async () => ({ category_id: 'not-allowed', confidence: 0.9 })
  });
  try {
    assert.equal((await classifyPost(missed, validBody)).statusCode, 204);
    assert.equal((await classifyPost(unknown, validBody)).statusCode, 204);
  } finally {
    await missed.close();
    await unknown.close();
  }
});

test('classifyTransaction posts the device request shape and accepts a listed id', async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ category_id: 'food', confidence: 0.8 }) } }] })
    };
  };
  try {
    const result = await classifyTransaction('gsk_test', parseClassifyBody(validBody));
    assert.deepEqual(result, { category_id: 'food', confidence: 0.8 });
    assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, 'Bearer gsk_test');
    const payload = JSON.parse(captured.init.body);
    assert.equal(payload.model, 'openai/gpt-oss-20b');
    assert.equal(payload.temperature, 0);
    assert.deepEqual(payload.response_format.json_schema.schema.properties.category_id.enum, ['food', 'travel']);
  } finally {
    globalThis.fetch = original;
  }
});

test('classifyTransaction returns null when Groq fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network');
  };
  try {
    assert.equal(await classifyTransaction('gsk_test', parseClassifyBody(validBody)), null);
  } finally {
    globalThis.fetch = original;
  }
});
