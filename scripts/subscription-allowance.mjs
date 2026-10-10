#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const workspacePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const reservedWorkspace = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export class SubscriptionAllowanceError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const invalid = () => { throw new SubscriptionAllowanceError('invalid-response'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const text = (value, maximum = 256) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid();
const rows = (value, maximum) => Array.isArray(value) && value.length <= maximum ? value : invalid();
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid();
const choice = (value, values) => values.includes(value) ? value : invalid();

export function validateAllowanceBaseUrl(value) {
  // Validate the supplied spelling too: WHATWG URL normalizes numeric aliases.
  if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) throw new SubscriptionAllowanceError('invalid-base-url');
  try { return new URL(value); } catch { throw new SubscriptionAllowanceError('invalid-base-url'); }
}

/** Experimental projection: preserve uncertainty, omit credentials and unknown fields. */
export function projectSubscriptionAllowance(input, now = Date.now()) {
  const source = object(input);
  const models = rows(source.models, 512).map(raw => {
    const model = object(raw);
    let status = choice(model.status, ['available', 'unknown', 'unavailable', 'stale']);
    const observedAt = model.observedAt === null ? null : iso(model.observedAt);
    const expired = observedAt === null || Date.parse(observedAt) > now || now - Date.parse(observedAt) >= 5 * 60 * 1000;
    if (status === 'available' && expired) status = 'stale';
    return {
      modelId: text(model.modelId), ...(model.modelName === undefined ? {} : { modelName: text(model.modelName) }),
      provider: text(model.provider, 128), status, observedAt,
      source: model.source === null ? null : choice(model.source, ['claude-sdk-usage', 'codex-app-server']),
      ...(model.accountGroup === undefined ? {} : { accountGroup: typeof model.accountGroup === 'string' && /^[a-f0-9]{64}$/.test(model.accountGroup) ? model.accountGroup : invalid() }),
      ...(model.policyModelIds === undefined ? {} : { policyModelIds: rows(model.policyModelIds, 512).map(value => text(value)) }),
      ...(model.reason === undefined ? {} : { reason: choice(model.reason, ['not-observed', 'unsupported', 'expired', 'collection-failed']) }),
      windows: rows(model.windows, 128).map(rawWindow => {
        const window = object(rawWindow);
        const resetAt = window.resetAt === null ? null : iso(window.resetAt);
        const percent = window.remainingPercent;
        if (percent !== null && !(typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100)) invalid();
        return { id: text(window.id), label: text(window.label), resetAt,
          remainingPercent: status === 'available' && !expired && (resetAt === null || Date.parse(resetAt) > now) ? percent : null,
          ...(window.modelFamily === undefined ? {} : { modelFamily: text(window.modelFamily, 128) }) };
      }),
    };
  });
  const entities = source.entities === undefined ? undefined : object(source.entities);
  const references = input => {
    const entries = Object.entries(object(input));
    if (entries.length > 2048) invalid();
    return Object.fromEntries(entries.map(([key, value]) => [text(key), rows(value, 512).map(item => text(item))]));
  };
  return { models, observedAt: iso(source.observedAt), ...(entities ? { entities: { flows: references(entities.flows), personas: references(entities.personas) } } : {}) };
}

async function boundedJson(response, maximum) {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new SubscriptionAllowanceError('response-budget-exceeded');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { invalid(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One cached GET. Never refreshes providers or starts a CLI/native process. */
export async function readSubscriptionAllowance({ baseUrl = 'http://127.0.0.1:4200', workspace = 'default-workspace', token,
  timeoutMs = 10_000, maxResponseBytes = MAX_BYTES, signal } = {}) {
  const url = validateAllowanceBaseUrl(baseUrl);
  if (typeof workspace !== 'string' || !workspacePattern.test(workspace) || reservedWorkspace.test(workspace) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_BYTES) throw new SubscriptionAllowanceError('invalid-arguments');
  if (token !== undefined && (typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token))) throw new SubscriptionAllowanceError('invalid-owner-token');
  url.pathname = '/api/model/allowance'; url.searchParams.set('workspace', workspace);
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
      redirect: 'manual', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400) throw new SubscriptionAllowanceError('redirect-refused');
    if (response.status !== 200) throw new SubscriptionAllowanceError('http-refused', response.status);
    const snapshot = projectSubscriptionAllowance(await boundedJson(response, maxResponseBytes));
    if (token && JSON.stringify(snapshot).includes(token)) invalid();
    return snapshot;
  } catch (error) {
    if (error instanceof SubscriptionAllowanceError) throw error;
    throw new SubscriptionAllowanceError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'request-timeout' : 'request-unavailable');
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

export function parseAllowanceArguments(args) {
  const values = {};
  if (args.length % 2 !== 0) throw new SubscriptionAllowanceError('invalid-arguments');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--base-url', '--workspace', '--timeout-ms'].includes(key) || key in values || !value || value.startsWith('--')) throw new SubscriptionAllowanceError('invalid-arguments');
    values[key] = value;
  }
  if (values['--timeout-ms'] !== undefined && !/^\d+$/.test(values['--timeout-ms'])) throw new SubscriptionAllowanceError('invalid-arguments');
  return { baseUrl: values['--base-url'], workspace: values['--workspace'], ...(values['--timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['--timeout-ms']) }) };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node scripts/subscription-allowance.mjs [--base-url http://127.0.0.1:4200] [--workspace NAME] [--timeout-ms 10000]'); return 0; }
  try {
    const snapshot = await readSubscriptionAllowance({ ...parseAllowanceArguments(args), token: env.FLUJO_OWNER_API_TOKEN });
    console.log(JSON.stringify(snapshot)); return 0;
  } catch (error) { console.error(JSON.stringify({ error: error instanceof SubscriptionAllowanceError ? error.code : 'request-unavailable',
    ...(error instanceof SubscriptionAllowanceError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) })); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
