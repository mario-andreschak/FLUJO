import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseProviderResponse } from './compaction-source-task-check.mjs';

// Probe the existing #1091 provider requirement before changing the runtime.
// No app profile, tools, model fallback, retry, or third-party effect is used.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2];
assert(report && path.isAbsolute(report), 'Provide an absolute private report path');
const model = process.env.COMPACTION_ACCEPTANCE_MODEL ?? 'openrouter/free';
assert(['openrouter/free', 'deepseek/deepseek-v4-flash', 'openai/gpt-6-luna',
  'anthropic/claude-haiku-5.5'].includes(model), 'Only explicit approved OpenRouter models; no fallback');
assert(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE && process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID,
  'Select the read-only configured-provider loader and one account');
const loader = await import(pathToFileURL(path.resolve(process.env.COMPACTION_ACCEPTANCE_PROVIDER_MODULE)).href);
const configured = await loader.loadConfiguredProvider(process.env.COMPACTION_ACCEPTANCE_ACCOUNT_ID, repo);
assert.equal(configured.model, 'openrouter/free');
assert.equal(new URL(configured.baseUrl).origin, 'https://openrouter.ai');
assert.equal(new URL(configured.baseUrl).pathname.replace(/\/$/, ''), '/api/v1');
const redact = value => String(value).replaceAll(configured.key, '[private]');
const digest = value => createHash('sha256').update(value).digest('hex');
const evidence = { schemaVersion: 1, issue: 1091, startedUtc: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true }).toString().trim(),
  sourceSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))),
  model, credential: configured.provenance, calls: [],
  scope: 'Direct approved OpenRouter capability and exact provider-window continuation; no application acceptance',
  sources: ['https://developers.openai.com/api/docs/guides/compaction',
    'https://openrouter.ai/docs/api/api-reference/responses/create-responses'] };
const save = () => fs.writeFile(report, redact(JSON.stringify(evidence, null, 2)), { mode: 0o600 });
const receipt = 'COMPACT-ñ-' + randomUUID();
const threshold = 1024;
const input = [
  { role: 'system', content: 'Read only. Never send, publish, write or call tools. Answer only the exact receipt from the user, without quotes or other text.' },
  { role: 'user', content: 'The exact current receipt is ' + receipt + '. Retain it exactly.' },
  { role: 'assistant', content: Array.from({ length: 600 }, (_, i) =>
    `Historical observation ${i}: no new instruction, permission, or receipt.`).join('\n') },
  { role: 'user', content: 'Repeat only the same exact receipt.' },
];
evidence.input = { sha256: digest(JSON.stringify(input)), characters: JSON.stringify(input).length,
  compactThreshold: threshold, receipt };
async function call(route, body, scenario) {
  assert(['/responses', '/responses/compact'].includes(route));
  assert.equal(body.model, model);
  assert(!body.models && !body.route && !body.provider && !body.tools, 'No router override, fallback, or tools');
  const row = { scenario, endpoint: 'https://openrouter.ai/api/v1' + route,
    startedUtc: new Date().toISOString(), request: body };
  evidence.calls.push(row); await save();
  const started = performance.now();
  try {
    const response = await fetch(row.endpoint, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${configured.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    const raw = redact(await response.text());
    let data;
    try { data = parseProviderResponse(raw); } catch { data = { raw }; }
    Object.assign(row, { httpStatus: response.status, contentType: response.headers.get('content-type'),
      elapsedMs: performance.now() - started, response: data, responseSha256: digest(raw), responseBytes: Buffer.byteLength(raw) });
    row.compactionItems = (data.output ?? []).filter(item => item.type === 'compaction'
      && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0).length;
    if (response.ok && model !== 'openrouter/free' && (route === '/responses' || data.model !== undefined)) {
      assert.equal(data.model, model, 'Exact explicit model required');
    }
    await save(); return row;
  } catch (error) {
    Object.assign(row, { elapsedMs: performance.now() - started, error: redact(error.message) });
    await save(); throw error;
  }
}
try {
  const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(30000) });
  assert(response.ok);
  const catalog = await response.json();
  const selected = catalog.data.find(item => item.id === model); assert(selected, 'Exact model must remain available');
  if (model === 'openrouter/free') assert(selected.pricing.prompt === '0' && selected.pricing.completion === '0');
  evidence.catalog = { checkedUtc: new Date().toISOString(), id: selected.id, pricing: selected.pricing,
    contextLength: selected.context_length, supportedParameters: selected.supported_parameters };
  const standalone = await call('/responses/compact', { model, input }, 'standalone-compaction');
  const serverSide = await call('/responses', { model, input, store: false, stream: false,
    max_output_tokens: 1200, context_management: [{ type: 'compaction', compact_threshold: threshold }] }, 'server-side-compaction');
  for (const row of [standalone, serverSide]) {
    if (row.httpStatus !== 200 || !row.compactionItems) continue;
    // Standalone output is the full next window, not just its opaque item.
    const nextInput = [...(row.scenario === 'standalone-compaction' ? row.response.output : [...input, ...row.response.output]),
      { role: 'user', content: 'After compaction repeat only the same exact receipt.' }];
    const continued = await call('/responses', { model, input: nextInput, store: false, stream: false,
      max_output_tokens: 1200 }, row.scenario + '-continuation');
    const text = (continued.response.output ?? []).flatMap(item => item.content ?? [])
      .filter(part => part.type === 'output_text').map(part => part.text).join('');
    continued.exactReceipt = text.trim() === receipt;
    assert(continued.httpStatus === 200 && continued.exactReceipt, 'Genuine compacted window must continue exactly');
  }
  evidence.outcome = [standalone, serverSide].some(row => row.httpStatus === 200 && row.compactionItems)
    ? 'genuine-provider-compaction-observed' : 'no-genuine-provider-compaction-observed';
} catch (error) {
  evidence.outcome = 'failed'; evidence.error = redact(error.message); process.exitCode = 1;
} finally {
  evidence.finishedUtc = new Date().toISOString();
  evidence.totalUsage = evidence.calls.reduce((sum, row) => {
    const usage = row.response?.usage;
    if (typeof usage?.cost === 'number') sum.reportedCostUsd += usage.cost;
    else sum.callsWithoutReportedCost++;
    return sum;
  }, { reportedCostUsd: 0, callsWithoutReportedCost: 0 });
  await save();
  console.log(JSON.stringify({ report, model, outcome: evidence.outcome, error: evidence.error,
    calls: evidence.calls.map(row => ({ scenario: row.scenario, httpStatus: row.httpStatus,
      compactionItems: row.compactionItems, providerError: row.response?.error, error: row.error })), totalUsage: evidence.totalUsage }));
}
