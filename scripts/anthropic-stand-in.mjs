// A local stand-in for Anthropic's service, answering in its documented formats, so the real
// Anthropic SDK, the real Agent SDK and the Claude Code bundled with it can run against it
// with no account, no key and no internet. Grew out of the container smoke's stand-in (#1408).
//
// What it serves, and where each format is documented:
//   POST /v1/messages        the Messages API, streamed (server-sent events) or not
//                            https://docs.claude.com/en/api/messages
//                            https://docs.claude.com/en/docs/build-with-claude/streaming
//   GET  /v1/models[/{id}]   the Models API https://docs.claude.com/en/api/models-list
//   GET  /api/oauth/usage    the subscription usage page that Claude Code's /usage and FLUJO read
// Every answer carries a `request-id`, errors use the documented error body
// (https://docs.claude.com/en/api/errors), API-key answers carry the documented
// `anthropic-ratelimit-*` headers (https://docs.claude.com/en/api/rate-limits) and subscription
// answers the `anthropic-ratelimit-unified-*` headers Claude Code reads for its plan limits.
// Requests sent with API version 2026-10-21 are held to that version's request rules
// (https://platform.claude.com/docs/en/api/migration-2026-10-21) and refused with the same 400.
// Prompt caching follows the documented prefix rules: up to four `cache_control` breakpoints, each
// also finding an earlier entry up to 20 blocks before it, a per-model minimum length,
// five-minute or one-hour entries
// (https://docs.claude.com/en/docs/build-with-claude/prompt-caching). Tokens are counted as
// four characters each; that is the stand-in's only simplification of the arithmetic.
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

/**
 * @typedef {{ type: string, [key: string]: unknown }} StandInBlock
 * @typedef {{ input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number }} StandInUsage
 * @typedef {{ blocks?: StandInBlock[], usage?: Partial<StandInUsage>, headers?: Record<string, string>, hang?: boolean,
 *   error?: { status: number, type: string, message: string, headers?: Record<string, string> } }} StandInReply
 * @typedef {{ at: number, method: string | undefined, path: string, beta: boolean, version: string | null, betas: string[],
 *   credential: string, oauth: boolean, bearer: boolean, apiKeyHeader: boolean, body: unknown, status: number,
 *   usage?: StandInUsage, reply?: StandInBlock[], hung?: boolean }} StandInRecord
 * @typedef {{ kind: string, value: string }} StandInCredential
 * @typedef {(request: { body: unknown, record: StandInRecord, index: number }) =>
 *   StandInReply | undefined | Promise<StandInReply | undefined>} StandInReplyFunction
 * @typedef {{ fiveHour?: number, sevenDay?: number, sevenDaySonnet?: number, sevenDayOpus?: number }} StandInSubscription
 * @typedef {{ status: number, body?: unknown, headers?: Record<string, string>, message?: string }} StandInUsagePage
 */

export const API_VERSIONS = Object.freeze({ current: '2026-10-21', previous: '2023-06-01' });
export const REMOVED_SAMPLING_FIELDS = Object.freeze(['temperature', 'top_p', 'top_k']);
const MAX_BODY = 32 * 1024 * 1024;
const MAX_BREAKPOINTS = 4;
const LOOKBACK_BLOCKS = 20;
const DAY = 24 * 60 * 60;

export async function readBody(request, limit = MAX_BODY) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error(`Request body is larger than ${limit} bytes.`), { status: 413, type: 'request_too_large' });
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

export function closer(server) {
  return () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A rough token count: four characters per token, at least one for any text. */
export const tokensOf = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text ? Math.ceil(text.length / 4) : 0;
};

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
export const textOf = (content) => blocksOf(content).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
export const systemTextOf = (system) => (Array.isArray(system) ? system.map((block) => block?.text ?? '').join('\n') : String(system ?? ''));

/** The request rules API version 2026-10-21 adds, each answered with the 400 the real API sends. */
export function versionViolation(body) {
  for (const field of REMOVED_SAMPLING_FIELDS) if (body && field in body) return `${field}: Extra inputs are not permitted`;
  for (const [index, message] of (Array.isArray(body?.messages) ? body.messages : []).entries()) {
    if (!Array.isArray(message?.content)) continue;
    if (message.role === 'assistant' && message.content.some((block) => block?.type === 'document')) {
      return `messages.${index}: document blocks are not allowed in assistant messages`;
    }
    if (message.role === 'user' && message.content.some((block) => block?.type === 'text' && (block.citations?.length ?? 0) > 0)) {
      return `messages.${index}: text blocks with citations are not allowed in user messages`;
    }
  }
  return undefined;
}

/** The documented minimum prefix a model caches; shorter prefixes are silently not cached. */
export function minimumCacheableTokens(model = '') {
  const name = String(model).toLowerCase();
  if (/opus-4-6|opus-4-5|haiku-4-5/.test(name)) return 4096;
  if (/opus-4-7|haiku-3-5|mythos-preview/.test(name)) return 2048;
  if (/opus-4-8|sonnet-5(?!-5)|sonnet-4|opus-4-1|opus-4(?!-)/.test(name)) return 1024;
  if (/opus-5|fable|mythos|sonnet-5-5|haiku-5-5/.test(name)) return 512;
  return 1024;
}

/** Claude Code's attribution line: the first system block, which changes between conversations. */
export const isAttributionBlock = (block) => typeof block?.text === 'string' && block.text.startsWith('x-anthropic-billing-header:');

/**
 * Tools, then system, then messages: the order a request's prefix is cached in. Claude Code's
 * attribution line is request metadata, not part of the cached prompt: it carries a per-conversation
 * suffix, and Claude Code's own cache breakpoints would never hit if it counted.
 */
function promptSegments(body) {
  const segments = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) segments.push({ value: tool, marker: tool?.cache_control });
  for (const block of typeof body?.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body?.system) ? body.system : []) {
    if (!isAttributionBlock(block)) segments.push({ value: block, marker: block?.cache_control });
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const block of blocksOf(message?.content)) segments.push({ value: [message.role, block], marker: block?.cache_control });
  }
  if (body?.cache_control && segments.length) segments.at(-1).marker ??= body.cache_control;
  return segments;
}

const strip = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner)));

/**
 * Prompt caching by prefix: a request reads the longest earlier cached prefix that ends at one
 * of its breakpoints or up to 20 blocks before one, writes its own breakpoints, and pays full
 * price only after the last one.
 */
export function createPromptCache({ now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    entries,
    /** The usage fields one request is charged, or an error message for more than four breakpoints. */
    charge(body) {
      const segments = promptSegments(body);
      const breakpoints = segments.flatMap((segment, index) => (segment.marker ? [index] : []));
      if (breakpoints.length > MAX_BREAKPOINTS) return { error: `A maximum of ${MAX_BREAKPOINTS} blocks with cache_control may be provided. Found ${breakpoints.length}.` };
      const hash = createHash('sha256').update(String(body?.model ?? ''));
      const prefixes = [];
      let tokens = 0;
      for (const segment of segments) {
        hash.update(JSON.stringify(strip(segment.value)));
        tokens += tokensOf(strip(segment.value));
        prefixes.push({ key: hash.copy().digest('hex'), tokens });
      }
      const total = tokens + tokensOf(body?.model ?? '');
      const minimum = minimumCacheableTokens(body?.model);
      const at = now();
      let read = 0;
      for (const breakpoint of [...breakpoints].reverse()) {
        for (let index = breakpoint; index >= Math.max(0, breakpoint - LOOKBACK_BLOCKS + 1) && prefixes[index].tokens > read; index--) {
          const entry = entries.get(prefixes[index].key);
          if (entry && entry.expiresAt > at) { read = prefixes[index].tokens; entry.expiresAt = at + entry.ttl; break; }
        }
      }
      let written = read;
      for (const index of breakpoints) {
        const { key, tokens: length } = prefixes[index];
        if (length < minimum) continue;
        const ttl = segments[index].marker?.ttl === '1h' ? 3_600_000 : 300_000;
        if (!entries.has(key) || entries.get(key).expiresAt <= at) entries.set(key, { ttl, expiresAt: at + ttl });
        written = Math.max(written, length);
      }
      const creation = written - read;
      return { input_tokens: Math.max(0, total - read - creation), cache_creation_input_tokens: creation, cache_read_input_tokens: read };
    },
  };
}

/**
 * The plan windows a subscription answer reports. `used` is the share already used (0 to 1);
 * the same numbers feed the `anthropic-ratelimit-unified-*` headers and the usage page.
 */
export function subscriptionWindows({ fiveHour = 0.1, sevenDay = 0.2, sevenDaySonnet, sevenDayOpus, now = Date.now() } = {}) {
  const seconds = Math.floor(now / 1000);
  const window = (used, resetIn) => (used === undefined ? undefined : { used, resetsAt: seconds + resetIn });
  return { five_hour: window(fiveHour, 3 * 3600), seven_day: window(sevenDay, 3 * DAY), seven_day_sonnet: window(sevenDaySonnet, 3 * DAY),
    seven_day_opus: window(sevenDayOpus, 3 * DAY) };
}

/** Claude warns at 90% of the five hours and at 75% of the week. */
const WARN_AT = { five_hour: 0.9, seven_day: 0.75 };
const HEADER_NAMES = { five_hour: '5h', seven_day: '7d' };

/** The subscription rate-limit headers of one answer, as Claude Code reads them. */
export function unifiedRateLimitHeaders(windows) {
  const headers = {};
  let status = 'allowed';
  let representative = 'five_hour';
  let resetsAt = windows.five_hour?.resetsAt ?? windows.seven_day?.resetsAt;
  for (const [id, short] of Object.entries(HEADER_NAMES)) {
    const window = windows[id];
    if (!window) continue;
    const windowStatus = window.used >= 1 ? 'rejected' : window.used >= WARN_AT[id] ? 'allowed_warning' : 'allowed';
    headers[`anthropic-ratelimit-unified-${short}-utilization`] = String(window.used);
    headers[`anthropic-ratelimit-unified-${short}-reset`] = String(window.resetsAt);
    headers[`anthropic-ratelimit-unified-${short}-status`] = windowStatus;
    if (windowStatus === 'allowed_warning') headers[`anthropic-ratelimit-unified-${short}-surpassed-threshold`] = String(WARN_AT[id]);
    const rank = { allowed: 0, allowed_warning: 1, rejected: 2 };
    if (rank[windowStatus] > rank[status]) { status = windowStatus; representative = id; resetsAt = window.resetsAt; }
  }
  return { ...headers, 'anthropic-ratelimit-unified-status': status, 'anthropic-ratelimit-unified-representative-claim': representative,
    ...(resetsAt ? { 'anthropic-ratelimit-unified-reset': String(resetsAt) } : {}), 'anthropic-ratelimit-unified-fallback-percentage': '0.5' };
}

/** The usage page's body for the same windows, in percent used. */
export function oauthUsageBody(windows) {
  const row = (window) => (window ? { utilization: Math.round(window.used * 1000) / 10, resets_at: new Date(window.resetsAt * 1000).toISOString() } : null);
  return { five_hour: row(windows.five_hour), seven_day: row(windows.seven_day), seven_day_oauth_apps: null,
    seven_day_opus: row(windows.seven_day_opus), seven_day_sonnet: row(windows.seven_day_sonnet),
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null } };
}

/** The documented API-key rate-limit headers: what is left this minute, and when it refills. */
export function apiKeyRateLimitHeaders({ requests = 50, inputTokens = 40_000, outputTokens = 8_000, used = { requests: 1, input: 0, output: 0 }, now = Date.now() } = {}) {
  const reset = new Date(Math.ceil(now / 60_000) * 60_000).toISOString();
  const left = (limit, spent) => String(Math.max(0, limit - spent));
  return {
    'anthropic-ratelimit-requests-limit': String(requests), 'anthropic-ratelimit-requests-remaining': left(requests, used.requests),
    'anthropic-ratelimit-requests-reset': reset,
    'anthropic-ratelimit-input-tokens-limit': String(inputTokens), 'anthropic-ratelimit-input-tokens-remaining': left(inputTokens, used.input),
    'anthropic-ratelimit-input-tokens-reset': reset,
    'anthropic-ratelimit-output-tokens-limit': String(outputTokens), 'anthropic-ratelimit-output-tokens-remaining': left(outputTokens, used.output),
    'anthropic-ratelimit-output-tokens-reset': reset,
    'anthropic-ratelimit-tokens-limit': String(inputTokens + outputTokens),
    'anthropic-ratelimit-tokens-remaining': left(inputTokens + outputTokens, used.input + used.output), 'anthropic-ratelimit-tokens-reset': reset,
  };
}

const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** The content blocks of an answer, with ids and signatures filled in. */
function completeBlocks(blocks, request) {
  return blocks.map((block, position) => {
    if (block.type === 'tool_use') return { type: 'tool_use', id: block.id ?? `toolu_${request}_${position}`, name: block.name, input: block.input ?? {} };
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? `stand-in-signature-${request}-${position}` };
    return { type: 'text', text: block.text ?? '' };
  });
}

/** The server-sent events of one streamed answer, in the documented order. */
export function messageEvents({ id = newId('msg'), model, blocks, usage = { input_tokens: 20, output_tokens: 8 } }) {
  const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const events = [['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }]];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      if (block.thinking) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

/** The documented error body. */
export function errorBody(type, message, requestId = newId('req')) {
  return { type: 'error', error: { type, message }, request_id: requestId };
}

function credentialOf(headers) {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
  if (bearer) return { kind: /^sk-ant-oat01-/.test(bearer) ? 'oauth' : 'bearer', value: bearer };
  const key = headers['x-api-key'];
  return key ? { kind: 'api-key', value: String(key) } : { kind: 'none', value: '' };
}

const MODELS = Object.freeze([
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-10-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z', max_input_tokens: 200_000, max_tokens: 64_000 },
]);

/**
 * Starts the stand-in. Options:
 *   reply({ body, record, index })  what to answer: { blocks, usage?, headers? }, { error: { status, type,
 *                                   message, headers? } } or { hang: true } (stream that never ends).
 *                                   Default: one short text answer.
 *   subscription                    plan windows (subscriptionWindows options) for OAuth answers; may be
 *                                   changed between requests. `subscriptionFor(credential)` on the
 *                                   returned object may give one login its own windows.
 *   acceptedVersions                API versions this server knows; others get a 400 naming anthropic-version.
 *   requireCredential               refuse requests without a key or token (default true).
 *   refuses(credential)             credentials answered with 401 (default: any containing "invalid").
 *   usagePage                       { status, body?, headers? } for GET /api/oauth/usage, or omit to derive
 *                                   it from `subscription`.
 * `requests` records every request as it arrives: path, version, betas, credential kind, body.
 */
/**
 * @param {{ port?: number, host?: string, reply?: StandInReplyFunction, subscription?: StandInSubscription,
 *   acceptedVersions?: string[], requireCredential?: boolean, refuses?: (credential: StandInCredential) => boolean,
 *   usagePage?: StandInUsagePage, now?: () => number }} [options]
 */
export async function startAnthropicStandIn({
  port = 0, host = '127.0.0.1', reply = () => ({ blocks: [{ type: 'text', text: 'Stand-in answer.' }] }),
  subscription = {}, acceptedVersions = [API_VERSIONS.previous, API_VERSIONS.current], requireCredential = true,
  refuses = (credential) => /invalid/i.test(credential.value), usagePage, now = () => Date.now(),
} = {}) {
  /** @type {StandInRecord[]} */
  const requests = [];
  const cache = createPromptCache({ now });
  /** @type {{ baseUrl: string, requests: StandInRecord[], cache: ReturnType<typeof createPromptCache>,
   *   subscription: StandInSubscription, subscriptionFor?: (credential: StandInCredential) => StandInSubscription | undefined,
   *   usagePage: StandInUsagePage | undefined, acceptedVersions: string[],
   *   reply: StandInReplyFunction, refusesCredential: (credential: StandInCredential) => boolean, close: () => Promise<void> }} */
  const standIn = { baseUrl: '', requests, cache, subscription, usagePage, acceptedVersions, reply, refusesCredential: refuses,
    close: async () => undefined };
  const send = (response, status, body, headers = {}) => {
    const requestId = newId('req');
    response.writeHead(status, { 'content-type': 'application/json', 'request-id': requestId, ...headers });
    response.end(JSON.stringify(body?.type === 'error' ? { ...body, request_id: requestId } : body));
  };
  const fail = (response, status, type, message, headers) => send(response, status, errorBody(type, message), headers);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://stand-in.invalid');
      const raw = await readBody(request);
      const credential = credentialOf(request.headers);
      const record = {
        at: now(), method: request.method, path: url.pathname, beta: url.searchParams.get('beta') === 'true',
        version: request.headers['anthropic-version'] ?? null,
        betas: String(request.headers['anthropic-beta'] ?? '').split(',').map((value) => value.trim()).filter(Boolean),
        credential: credential.kind, oauth: credential.kind === 'oauth', bearer: Boolean(request.headers.authorization),
        apiKeyHeader: Boolean(request.headers['x-api-key']), body: undefined, status: 0,
      };
      requests.push(record);
      const answer = (status, body, headers) => { record.status = status; send(response, status, body, headers); };
      const refuse = (status, type, message, headers) => { record.status = status; fail(response, status, type, message, headers); };
      if ((requireCredential && credential.kind === 'none') || (credential.kind !== 'none' && standIn.refusesCredential(credential))) {
        refuse(401, 'authentication_error', credential.kind === 'oauth' ? 'OAuth token has expired. Please obtain a new token or refresh your existing token.'
          : credential.kind === 'none' ? 'x-api-key header is required' : 'invalid x-api-key');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/oauth/usage') {
        const plan = standIn.subscriptionFor?.(credential) ?? standIn.subscription;
        const page = standIn.usagePage ?? { status: 200, body: oauthUsageBody(subscriptionWindows({ ...plan, now: now() })) };
        if (page.status === 200) answer(200, page.body, page.headers);
        else refuse(page.status, page.status === 429 ? 'rate_limit_error' : page.status === 403 ? 'permission_error' : 'api_error', page.message ?? 'Usage is not available.', page.headers);
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
        const models = MODELS.map((model) => ({ type: 'model', ...model }));
        const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        if (url.pathname === '/v1/models') answer(200, { data: models, has_more: false, first_id: models[0].id, last_id: models.at(-1).id });
        else if (models.some((model) => model.id === id)) answer(200, models.find((model) => model.id === id));
        else refuse(404, 'not_found_error', `model: ${id}`);
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
        refuse(404, 'not_found_error', `The stand-in does not serve ${request.method} ${url.pathname}.`);
        return;
      }
      if (record.version && !standIn.acceptedVersions.includes(record.version)) {
        refuse(400, 'invalid_request_error', `anthropic-version: "${record.version}" is not a supported API version`);
        return;
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); }
      catch { refuse(400, 'invalid_request_error', 'There was an issue with the request body: it is not valid JSON.'); return; }
      record.body = body;
      const broken = record.version === API_VERSIONS.current ? versionViolation(body) : undefined;
      if (broken) { refuse(400, 'invalid_request_error', broken); return; }
      const charged = cache.charge(body);
      if (charged.error) { refuse(400, 'invalid_request_error', charged.error); return; }
      const windows = subscriptionWindows({ ...(standIn.subscriptionFor?.(credential) ?? standIn.subscription), now: now() });
      const limitHeaders = credential.kind === 'oauth' ? unifiedRateLimitHeaders(windows) : apiKeyRateLimitHeaders({ now: now() });
      if (credential.kind === 'oauth' && limitHeaders['anthropic-ratelimit-unified-status'] === 'rejected') {
        const resetsAt = Number(limitHeaders['anthropic-ratelimit-unified-reset']);
        refuse(429, 'rate_limit_error', 'Rate limit exceeded', { ...limitHeaders, 'retry-after': String(Math.max(1, resetsAt - Math.floor(now() / 1000))) });
        return;
      }
      const index = requests.filter((entry) => entry.path === '/v1/messages' && entry.body).length - 1;
      const planned = await standIn.reply({ body, record, index });
      if (planned?.error) {
        refuse(planned.error.status, planned.error.type, planned.error.message, { ...limitHeaders, ...planned.error.headers });
        return;
      }
      const blocks = completeBlocks(planned?.blocks ?? [], index + 1);
      const outputTokens = planned?.usage?.output_tokens ?? Math.max(1, blocks.reduce((sum, block) => sum + tokensOf(block.text ?? block.thinking ?? block.input), 0));
      const usage = { ...charged, ...planned?.usage, output_tokens: outputTokens };
      record.usage = usage;
      record.reply = blocks;
      record.status = 200;
      const headers = { ...limitHeaders, ...planned?.headers };
      const id = newId('msg');
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': newId('req'), ...headers });
        const events = messageEvents({ id, model: body.model, blocks, usage });
        if (planned?.hang) {
          response.write(`event: message_start\ndata: ${JSON.stringify(events[0][1])}\n\n`);
          record.hung = true;
          return;
        }
        for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        response.end();
        return;
      }
      send(response, 200, { id, type: 'message', role: 'assistant', model: body.model, content: blocks,
        stop_reason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage }, headers);
    } catch (error) {
      if (!response.headersSent) fail(response, error?.status ?? 500, error?.type ?? 'api_error', String(error?.message ?? error));
      else response.end();
    }
  });
  const chosen = await listen(server, port, host);
  standIn.baseUrl = `http://${host}:${chosen}`;
  standIn.close = closer(server);
  return standIn;
}
