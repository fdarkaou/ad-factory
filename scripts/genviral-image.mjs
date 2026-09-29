#!/usr/bin/env node
// Zero-dependency CLI for the Genviral Partner API image endpoint.
// Usage: node scripts/genviral-image.mjs --help
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://www.genviral.io/api/partner/v1';

const ASPECTS = ['1:1', '4:5', '9:16', '16:9', '4:3', '3:4'];
const SIZES = ['1K', '2K', '4K'];
const QUALITIES = ['low', 'medium', 'high'];
const FORMATS = ['png', 'jpeg', 'webp'];
const MAX_REFS = 14;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;
const REF_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const HELP = `Generate one image through the Genviral Partner API.

Required:
  --model <id>          e.g. openai/gpt-image-2.5-flare or openai/gpt-image-2.5-sunburst
  --prompt <text>       or --prompt-file <path>
  --out <path>          where to save the image

Optional:
  --aspect <ratio>      ${ASPECTS.join(' | ')} (default 1:1)
  --size <tier>         ${SIZES.join(' | ')} (default 1K)
  --quality <tier>      ${QUALITIES.join(' | ')} (default medium)
  --format <type>       ${FORMATS.join(' | ')} (default png)
  --ref <url|path>      reference image, repeatable (max ${MAX_REFS}); local files are uploaded first
  --key <string>        Idempotency-Key; default is derived from the request and --out,
                        so a rerun replays the earlier result instead of paying twice

Env: GENVIRAL_API_KEY (required), GENVIRAL_API_BASE_URL (optional)
Prints one JSON object to stdout on success.`;

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const VALUE_FLAGS = new Set([
  '--model',
  '--prompt',
  '--prompt-file',
  '--out',
  '--aspect',
  '--size',
  '--quality',
  '--format',
  '--ref',
  '--key',
]);

export function parseArgs(argv) {
  const options = { refs: [], aspect: '1:1', size: '1K', quality: 'medium', format: 'png' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      return { help: true };
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new CliError(`Unknown argument: ${flag}`, 2);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`${flag} needs a value`, 2);
    }
    index += 1;
    assignOption(options, flag, value);
  }
  validateOptions(options);
  return options;
}

function assignOption(options, flag, value) {
  if (flag === '--ref') {
    options.refs.push(value);
    return;
  }
  const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  options[key] = value;
}

function validateOptions(options) {
  requireOption(options.model, '--model');
  requireOption(options.out, '--out');
  if (!options.prompt && !options.promptFile) {
    throw new CliError('--prompt or --prompt-file is required', 2);
  }
  requireChoice(options.aspect, ASPECTS, '--aspect');
  requireChoice(options.size, SIZES, '--size');
  requireChoice(options.quality, QUALITIES, '--quality');
  requireChoice(options.format, FORMATS, '--format');
  if (options.refs.length > MAX_REFS) {
    throw new CliError(`At most ${MAX_REFS} --ref values are allowed`, 2);
  }
}

function requireOption(value, flag) {
  if (!value) {
    throw new CliError(`${flag} is required`, 2);
  }
}

function requireChoice(value, choices, flag) {
  if (!choices.includes(value)) {
    throw new CliError(`${flag} must be one of ${choices.join(', ')} (got "${value}")`, 2);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeApiError({ method, path, status, payload }) {
  const parts = [`Genviral API ${method} ${path} failed with HTTP ${status}`];
  if (isObject(payload)) {
    if (payload.error_code) {
      parts.push(`error_code=${payload.error_code}`);
    }
    if (payload.message) {
      parts.push(String(payload.message));
    }
    if (payload.remediation_hint) {
      parts.push(String(payload.remediation_hint));
    }
    if (payload.action_url) {
      parts.push(`see ${payload.action_url}`);
    }
  }
  return parts.join(': ');
}

function createClient({ fetch, apiKey, baseUrl }) {
  const redact = (text) => text.split(apiKey).join('[redacted]');

  async function call(method, path, { body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(redact(`Network error on ${method} ${path}: ${error.message}`));
    }
    const payload = await readJson(response);
    if (!response.ok || !isObject(payload) || payload.ok === false) {
      throw new CliError(redact(describeApiError({ method, path, status: response.status, payload })));
    }
    if (!isObject(payload.data)) {
      throw new CliError(`Unexpected response from ${method} ${path}: no data object`);
    }
    return payload.data;
  }

  return { call };
}

async function uploadLocalReference({ client, deps, path }) {
  const contentType = REF_MIME_TYPES[extname(path).toLowerCase()];
  if (!contentType) {
    throw new CliError(`Unsupported reference file type: ${path} (use png, jpg or webp)`, 2);
  }
  const bytes = await deps.readFile(path);
  const fileBody = { contentType, filename: basename(path), bytes: bytes.length };
  const digest = sha256(bytes).slice(0, 40);

  const prepared = await client.call('POST', '/files', {
    body: fileBody,
    idempotencyKey: `ad-factory-upload-${digest}`,
  });
  if (!isNonEmptyString(prepared.id) || !isNonEmptyString(prepared.uploadUrl)) {
    throw new CliError('Upload preparation returned no id or uploadUrl');
  }

  const put = await deps.fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!put.ok) {
    throw new CliError(`Uploading ${path} failed with HTTP ${put.status}`);
  }

  const finalized = await client.call('POST', `/files/${prepared.id}/finalize`, {
    body: fileBody,
    idempotencyKey: `ad-factory-finalize-${prepared.id}`,
  });
  if (!isObject(finalized.file) || !isNonEmptyString(finalized.file.url)) {
    throw new CliError('Upload finalize returned no file.url');
  }
  return finalized.file.url;
}

async function resolveReferences({ client, deps, refs }) {
  const urls = [];
  for (const ref of refs) {
    if (/^https?:\/\//i.test(ref)) {
      urls.push(ref);
      continue;
    }
    urls.push(await uploadLocalReference({ client, deps, path: ref }));
  }
  return urls;
}

async function waitForOutput({ client, deps, generated }) {
  if (isNonEmptyString(generated.output_url)) {
    return generated.output_url;
  }
  if (!isNonEmptyString(generated.image_id)) {
    throw new CliError('Generate response had neither output_url nor image_id');
  }
  const deadline = deps.now() + POLL_TIMEOUT_MS;
  while (deps.now() <= deadline) {
    const status = await client.call('GET', `/studio/images/${generated.image_id}`);
    if (status.status === 'succeeded' && isNonEmptyString(status.output_url)) {
      return status.output_url;
    }
    if (status.status === 'failed') {
      throw new CliError(`Image ${generated.image_id} failed: ${status.error ?? 'no reason given'}`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new CliError(
    `Image ${generated.image_id} still processing after ${POLL_TIMEOUT_MS / 1000}s. ` +
      'Rerun the same command later; the same Idempotency-Key replays this job.',
  );
}

async function downloadImage({ deps, url, out }) {
  const response = await deps.fetch(url);
  if (!response.ok) {
    throw new CliError(`Downloading the generated image failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new CliError('Downloaded image is empty');
  }
  await deps.mkdir(dirname(out), { recursive: true });
  await deps.writeFile(out, bytes);
}

function withDefaults(deps) {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    ...deps,
  };
}

export async function run(argv, injected = {}) {
  const deps = withDefaults(injected);
  const options = parseArgs(argv);
  if (options.help) {
    return { help: HELP };
  }
  const apiKey = deps.env.GENVIRAL_API_KEY?.trim();
  if (!apiKey) {
    throw new CliError('GENVIRAL_API_KEY is not set. Create a key under API Keys at genviral.io.', 2);
  }
  const baseUrl = (deps.env.GENVIRAL_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const client = createClient({ fetch: deps.fetch, apiKey, baseUrl });

  const prompt = options.prompt ?? String(await deps.readFile(options.promptFile, 'utf8')).trim();
  const referenceUrls = await resolveReferences({ client, deps, refs: options.refs });
  const body = {
    model_id: options.model,
    prompt,
    ...(referenceUrls.length > 0 ? { image_urls: referenceUrls } : {}),
    params: { aspect_ratio: options.aspect, size: options.size, output_format: options.format },
    raw_params: { quality: options.quality },
  };
  const idempotencyKey =
    options.key ?? `ad-factory-${sha256(JSON.stringify({ body, out: options.out })).slice(0, 48)}`;

  const generated = await client.call('POST', '/studio/images/generate', { body, idempotencyKey });
  const outputUrl = await waitForOutput({ client, deps, generated });
  await downloadImage({ deps, url: outputUrl, out: options.out });

  return {
    model_id: options.model,
    image_id: generated.image_id ?? null,
    output_url: outputUrl,
    credits_used: generated.credits_used ?? null,
    out: options.out,
    idempotency_key: idempotencyKey,
    reference_urls: referenceUrls,
  };
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(`${result.help ?? JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const isCliError = error instanceof CliError;
    process.stderr.write(`genviral-image: ${isCliError ? error.message : 'unexpected error'}\n`);
    process.exitCode = isCliError ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
