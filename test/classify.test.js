import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransaction, parseClassifyBody, runClassify } from '../src/classify/groq.ts';

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

test('parseClassifyBody rejects a missing allowed_categories array', () => {
  assert.throws(() => parseClassifyBody({ ...validBody, allowed_categories: undefined }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody({ merchant: 'x' }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody({ ...validBody, allowed_categories: 'food' }), /allowed_categories is required/);
  assert.throws(() => parseClassifyBody(null), /allowed_categories is required/);
});

test('parseClassifyBody accepts a valid body', () => {
  assert.deepEqual(parseClassifyBody(validBody), validBody);
});

test('runClassify is null when the groq key is missing without calling Groq', async () => {
  const body = parseClassifyBody(validBody);
  const result = await runClassify(null, body, async () => {
    throw new Error('should not call Groq');
  });
  assert.equal(result, null);
});

test('runClassify returns an injected result and drops unknown ids', async () => {
  const body = parseClassifyBody(validBody);
  assert.deepEqual(await runClassify('gsk_test', body, async () => ({ category_id: 'food', confidence: 0.91 })), {
    category_id: 'food',
    confidence: 0.91
  });
  assert.equal(await runClassify('gsk_test', body, async () => ({ category_id: 'not-allowed', confidence: 0.9 })), null);
  assert.equal(await runClassify('gsk_test', body, async () => null), null);
});

test('runClassify is null for an empty allowed_categories list', async () => {
  const body = parseClassifyBody({ ...validBody, allowed_categories: [] });
  const result = await runClassify('gsk_test', body, async () => {
    throw new Error('should not call Groq for an empty list');
  });
  assert.equal(result, null);
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
