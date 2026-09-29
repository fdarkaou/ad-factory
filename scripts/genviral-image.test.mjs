import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliError, run } from './genviral-image.mjs';

const API_KEY = 'pk_test.secret_value_123';
const BASE = 'https://www.genviral.io/api/partner/v1';
const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageBytes() {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

function makeDeps(routes, overrides = {}) {
  const calls = [];
  const files = new Map();
  const deps = {
    env: { GENVIRAL_API_KEY: API_KEY },
    fetch: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, headers: init.headers ?? {}, body: init.body });
      const handler = routes[`${method} ${url}`];
      if (!handler) {
        throw new Error(`Unexpected request ${method} ${url}`);
      }
      return handler(init);
    },
    sleep: async () => {},
    readFile: async () => Buffer.from([1, 2, 3, 4]),
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    mkdir: async () => {},
    ...overrides,
  };
  return { deps, calls, files };
}

const BASE_ARGS = [
  '--model',
  'openai/gpt-image-2.5-sunburst',
  '--prompt',
  'A clean 4:5 static ad',
  '--aspect',
  '4:5',
  '--size',
  '2K',
  '--quality',
  'high',
  '--out',
  'creatives/2026-09-29/c01/final-4x5.png',
];

test('generates an image, polls until it succeeds and saves it', async () => {
  let polls = 0;
  const { deps, calls, files } = makeDeps({
    [`POST ${BASE}/studio/images/generate`]: () =>
      json(201, {
        ok: true,
        code: 201,
        data: { image_id: IMAGE_ID, status: 'processing', output_url: null, credits_used: 4 },
      }),
    [`GET ${BASE}/studio/images/${IMAGE_ID}`]: () => {
      polls += 1;
      const done = polls > 1;
      return json(200, {
        ok: true,
        code: 200,
        data: {
          image_id: IMAGE_ID,
          status: done ? 'succeeded' : 'processing',
          output_url: done ? 'https://cdn.example.com/img.png' : null,
        },
      });
    },
    'GET https://cdn.example.com/img.png': () => imageBytes(),
  });

  const result = await run([...BASE_ARGS, '--ref', 'https://cdn.example.com/logo.png'], deps);

  const generate = calls[0];
  assert.equal(generate.headers.Authorization, `Bearer ${API_KEY}`);
  assert.ok(generate.headers['Idempotency-Key']);
  const body = JSON.parse(generate.body);
  assert.equal(body.model_id, 'openai/gpt-image-2.5-sunburst');
  assert.deepEqual(body.image_urls, ['https://cdn.example.com/logo.png']);
  assert.deepEqual(body.params, { aspect_ratio: '4:5', size: '2K', output_format: 'png' });
  assert.deepEqual(body.raw_params, { quality: 'high' });
  assert.equal(polls, 2);
  assert.equal(result.image_id, IMAGE_ID);
  assert.equal(result.credits_used, 4);
  assert.equal(result.output_url, 'https://cdn.example.com/img.png');
  assert.equal(files.get('creatives/2026-09-29/c01/final-4x5.png').length, 4);
});

test('accepts a synchronous response that already carries output_url', async () => {
  const { deps, calls } = makeDeps({
    [`POST ${BASE}/studio/images/generate`]: () =>
      json(201, {
        ok: true,
        code: 201,
        data: { file_id: FILE_ID, output_url: 'https://cdn.example.com/sync.png', credits_used: 1 },
      }),
    'GET https://cdn.example.com/sync.png': () => imageBytes(),
  });

  const result = await run(BASE_ARGS, deps);

  assert.equal(calls.length, 2);
  assert.equal(result.output_url, 'https://cdn.example.com/sync.png');
});

test('uploads a local reference image before generating', async () => {
  const { deps, calls } = makeDeps({
    [`POST ${BASE}/files`]: () =>
      json(201, {
        ok: true,
        code: 201,
        data: { id: FILE_ID, uploadUrl: 'https://s3.example.com/put', contentType: 'image/png' },
      }),
    'PUT https://s3.example.com/put': () => new Response(null, { status: 200 }),
    [`POST ${BASE}/files/${FILE_ID}/finalize`]: () =>
      json(200, { ok: true, code: 200, data: { file: { url: 'https://cdn.example.com/logo.png' } } }),
    [`POST ${BASE}/studio/images/generate`]: () =>
      json(201, {
        ok: true,
        code: 201,
        data: { output_url: 'https://cdn.example.com/out.png', credits_used: 4 },
      }),
    'GET https://cdn.example.com/out.png': () => imageBytes(),
  });

  const result = await run([...BASE_ARGS, '--ref', 'product/assets/logo.png'], deps);

  const put = calls.find((call) => call.method === 'PUT');
  assert.equal(put.headers.Authorization, undefined);
  const generate = calls.find((call) => call.url.endsWith('/studio/images/generate'));
  assert.deepEqual(JSON.parse(generate.body).image_urls, ['https://cdn.example.com/logo.png']);
  assert.deepEqual(result.reference_urls, ['https://cdn.example.com/logo.png']);
});

test('surfaces API errors with the error code and without the key', async () => {
  const { deps } = makeDeps({
    [`POST ${BASE}/studio/images/generate`]: () =>
      json(402, {
        ok: false,
        code: 402,
        message: 'More credits are required for this action.',
        error_code: 'insufficient_credits',
        action_url: 'https://www.genviral.io/billing?tab=credits',
      }),
  });

  await assert.rejects(run(BASE_ARGS, deps), (error) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /402/);
    assert.match(error.message, /insufficient_credits/);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
});

test('fails when generation reports a failed status', async () => {
  const { deps } = makeDeps({
    [`POST ${BASE}/studio/images/generate`]: () =>
      json(201, { ok: true, code: 201, data: { image_id: IMAGE_ID, status: 'processing' } }),
    [`GET ${BASE}/studio/images/${IMAGE_ID}`]: () =>
      json(200, {
        ok: true,
        code: 200,
        data: { image_id: IMAGE_ID, status: 'failed', error: 'Image generation failed.' },
      }),
  });

  await assert.rejects(run(BASE_ARGS, deps), /failed/);
});

test('refuses to run without GENVIRAL_API_KEY and makes no request', async () => {
  const { deps, calls } = makeDeps({}, { env: {} });

  await assert.rejects(run(BASE_ARGS, deps), (error) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /GENVIRAL_API_KEY/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('rejects an unsupported aspect ratio before calling the API', async () => {
  const { deps, calls } = makeDeps({});
  const args = BASE_ARGS.map((value) => (value === '4:5' ? '2:1' : value));

  await assert.rejects(run(args, deps), /--aspect/);
  assert.equal(calls.length, 0);
});
