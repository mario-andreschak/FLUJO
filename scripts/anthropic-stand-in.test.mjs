import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_VERSIONS, COMPACTION_BETA, createPromptCache, minimumCacheableTokens, oauthUsageBody, signSummary, startAnthropicStandIn,
  subscriptionWindows, unifiedRateLimitHeaders, versionViolation,
} from './anthropic-stand-in.mjs';

const OAUTH = { authorization: 'Bearer sk-ant-oat01-stand-in-placeholder', 'content-type': 'application/json' };
const KEY = { 'x-api-key': 'stand-in-key', 'content-type': 'application/json', 'anthropic-version': API_VERSIONS.current };

async function post(standIn, headers, body) {
  const response = await fetch(`${standIn.baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { response, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}

test('2026-10-21 refuses the removed sampling fields, assistant documents and cited user text, and nothing else', () => {
  const plain = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(versionViolation(plain), undefined);
  assert.match(versionViolation({ ...plain, temperature: 1 }), /temperature: Extra inputs are not permitted/);
  assert.match(versionViolation({ ...plain, top_k: 5 }), /top_k/);
  assert.match(versionViolation({ model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'document' }] }] }),
    /messages\.1: document blocks/);
  assert.match(versionViolation({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x', citations: [{}] }] }] }),
    /citations are not allowed in user messages/);
});

test('prompt caching reads an identical prefix, writes only from the minimum length, and allows at most four breakpoints', () => {
  let clock = 0;
  const cache = createPromptCache({ now: () => clock });
  const long = 'x'.repeat(5000 * 4);
  const request = (question, extra = {}) => ({ model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: question }], ...extra });
  const first = cache.charge(request('one'));
  assert.ok(first.cache_creation_input_tokens >= 5000);
  assert.equal(first.cache_read_input_tokens, 0);
  const second = cache.charge(request('two'));
  assert.equal(second.cache_read_input_tokens, first.cache_creation_input_tokens);
  assert.equal(second.cache_creation_input_tokens, 0);
  assert.ok(second.input_tokens > 0);
  // A different system text is a different prefix.
  assert.equal(cache.charge({ ...request('three'), system: [{ type: 'text', text: `${long}!`, cache_control: { type: 'ephemeral' } }] }).cache_read_input_tokens, 0);
  // Entries live five minutes from their last use.
  clock += 301_000;
  assert.equal(cache.charge(request('four')).cache_read_input_tokens, 0);
  // Too short to cache on this model: nothing is written or read.
  const short = { model: 'claude-haiku-4-5', system: [{ type: 'text', text: 'short', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'q' }] };
  assert.deepEqual([cache.charge(short).cache_creation_input_tokens, cache.charge(short).cache_read_input_tokens], [0, 0]);
  assert.equal(minimumCacheableTokens('claude-haiku-4-5'), 4096);
  assert.equal(minimumCacheableTokens('claude-opus-5-5'), 512);
  // An earlier breakpoint up to 20 blocks back still counts, and the attribution line never does.
  const turn = (messages) => ({ model: 'claude-sonnet-4-6', system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1.' + messages.length },
    { type: 'text', text: long, cache_control: { type: 'ephemeral' } }], messages });
  const history = [{ role: 'user', content: [{ type: 'text', text: 'first question', cache_control: { type: 'ephemeral' } }] }];
  cache.charge(turn(history));
  const later = cache.charge(turn([{ role: 'user', content: 'first question' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }] }]));
  assert.ok(later.cache_read_input_tokens > 5000);
  const five = Array.from({ length: 5 }, (_, index) => ({ type: 'text', text: `block ${index}`, cache_control: { type: 'ephemeral' } }));
  assert.match(cache.charge({ model: 'm', system: five, messages: [] }).error, /maximum of 4 blocks with cache_control/);
});

test('subscription windows give the same numbers to the rate-limit headers and to the usage page', () => {
  const now = Date.UTC(2026, 10, 28);
  const windows = subscriptionWindows({ fiveHour: 0.12, sevenDay: 0.88, now });
  const headers = unifiedRateLimitHeaders(windows);
  assert.equal(headers['anthropic-ratelimit-unified-5h-utilization'], '0.12');
  assert.equal(headers['anthropic-ratelimit-unified-7d-utilization'], '0.88');
  assert.equal(headers['anthropic-ratelimit-unified-7d-status'], 'allowed_warning');
  assert.equal(headers['anthropic-ratelimit-unified-7d-surpassed-threshold'], '0.75');
  assert.equal(headers['anthropic-ratelimit-unified-status'], 'allowed_warning');
  assert.equal(headers['anthropic-ratelimit-unified-representative-claim'], 'seven_day');
  const page = oauthUsageBody(windows);
  assert.deepEqual([page.five_hour.utilization, page.seven_day.utilization], [12, 88]);
  assert.equal(page.seven_day.resets_at, new Date(windows.seven_day.resetsAt * 1000).toISOString());
  assert.equal(unifiedRateLimitHeaders(subscriptionWindows({ fiveHour: 1, now }))['anthropic-ratelimit-unified-status'], 'rejected');
});

test('the stand-in answers streamed and plain requests with usage, request ids and the right rate-limit headers', async (t) => {
  const standIn = await startAnthropicStandIn({ subscription: { fiveHour: 0.2, sevenDay: 0.3 },
    reply: ({ index }) => ({ blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: `answer ${index}` }] }) });
  t.after(() => standIn.close());
  const streamed = await post(standIn, OAUTH, { model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(streamed.response.status, 200);
  assert.match(streamed.response.headers.get('request-id'), /^req_/);
  assert.equal(streamed.response.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.2');
  const events = streamed.body.split('\n\n').filter(Boolean).map((block) => block.split('\n')[0].slice('event: '.length));
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const plain = await post(standIn, KEY, { model: 'claude-haiku-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.response.status, 200);
  assert.equal(plain.body.content[1].text, 'answer 1');
  assert.ok(plain.body.usage.input_tokens > 0 && plain.body.usage.output_tokens > 0);
  assert.equal(plain.response.headers.get('anthropic-ratelimit-requests-limit'), '50');
  assert.equal(plain.response.headers.get('anthropic-ratelimit-unified-status'), null);
  assert.deepEqual(standIn.requests.map((request) => [request.credential, request.version]),
    [['oauth', null], ['api-key', API_VERSIONS.current]]);
});

test('the stand-in refuses what the real service refuses, in the documented error shape', async (t) => {
  const standIn = await startAnthropicStandIn({ acceptedVersions: [API_VERSIONS.previous] });
  t.after(() => standIn.close());
  const missing = await post(standIn, { 'content-type': 'application/json' }, { model: 'm', messages: [] });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error.type, 'authentication_error');
  assert.match(missing.body.request_id, /^req_/);
  const invalid = await post(standIn, { ...OAUTH, authorization: 'Bearer sk-ant-oat01-invalid' }, { model: 'm', messages: [] });
  assert.equal(invalid.response.status, 401);
  assert.match(invalid.body.error.message, /OAuth token has expired/);
  const version = await post(standIn, KEY, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(version.response.status, 400);
  assert.match(version.body.error.message, /anthropic-version/);
  standIn.acceptedVersions = [API_VERSIONS.current];
  const sampled = await post(standIn, KEY, { model: 'm', temperature: 0.5, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(sampled.response.status, 400);
  assert.equal(sampled.body.error.type, 'invalid_request_error');
  standIn.subscription = { fiveHour: 1 };
  const limited = await post(standIn, OAUTH, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.type, 'rate_limit_error');
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  assert.equal(limited.response.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  standIn.reply = () => ({ error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } });
  standIn.subscription = {};
  const overloaded = await post(standIn, OAUTH, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(overloaded.response.status, 529);
  assert.equal(overloaded.body.error.type, 'overloaded_error');
});

test('the usage page and the Models API answer in their documented shapes', async (t) => {
  const standIn = await startAnthropicStandIn({ subscription: { fiveHour: 0.4, sevenDay: 0.5, sevenDaySonnet: 0.6 } });
  t.after(() => standIn.close());
  const usage = await fetch(`${standIn.baseUrl}/api/oauth/usage`, { headers: OAUTH });
  assert.equal(usage.status, 200);
  const page = await usage.json();
  assert.deepEqual([page.five_hour.utilization, page.seven_day.utilization, page.seven_day_sonnet.utilization, page.seven_day_opus], [40, 50, 60, null]);
  standIn.usagePage = { status: 403, message: 'OAuth token does not meet scope requirement user:profile' };
  const refused = await fetch(`${standIn.baseUrl}/api/oauth/usage`, { headers: OAUTH });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.type, 'permission_error');
  const models = await (await fetch(`${standIn.baseUrl}/v1/models`, { headers: KEY })).json();
  assert.equal(models.has_more, false);
  assert.ok(models.data.every((model) => model.type === 'model' && model.id && model.display_name && model.created_at));
  assert.equal((await fetch(`${standIn.baseUrl}/v1/models/claude-unknown`, { headers: KEY })).status, 404);
});

test('on-demand compaction returns one signed block and holds later requests to the documented rules', async () => {
  const standIn = await startAnthropicStandIn();
  try {
    const BETA = { ...KEY, 'anthropic-beta': COMPACTION_BETA };
    const history = [{ role: 'user', content: 'Plan the data model.' }, { role: 'assistant', content: 'Recipe and Step.' }];
    assert.match((await post(standIn, KEY, { model: 'claude-opus-5-5', max_tokens: 4096, messages: history, compaction: { type: 'summarize' } }))
      .body.error.message, /requires anthropic-beta/);
    const compacted = await post(standIn, BETA, { model: 'claude-opus-5-5', max_tokens: 4096, messages: history, compaction: { type: 'summarize' } });
    assert.equal(compacted.body.stop_reason, 'compaction');
    const [block] = compacted.body.content;
    assert.deepEqual(Object.keys(block).sort(), ['content', 'signature', 'type']);
    assert.equal(block.signature, signSummary(block.content));
    assert.equal(compacted.body.usage.input_tokens, 0);
    assert.equal(compacted.body.usage.iterations[0].type, 'compaction');
    assert.deepEqual(standIn.compaction.signed, [block]);

    const next = (messages, headers = BETA) => post(standIn, headers, { model: 'claude-opus-5-5', max_tokens: 256, messages });
    const later = [{ role: 'assistant', content: [block] }, { role: 'user', content: 'Fields for Recipe?' }];
    assert.equal((await next(later)).response.status, 200);
    assert.match((await next(later, KEY)).body.error.message, /does not match any of the expected tags/);
    assert.equal((await next([{ role: 'user', content: 'x' }, ...later])).body.error.details.error_code, 'compaction_block_misplaced');
    assert.equal((await next([{ role: 'assistant', content: [{ ...block, content: `${block.content}!` }] }, later[1]]))
      .body.error.details.error_code, 'compaction_signature_invalid');
    assert.match((await next([{ role: 'assistant', content: [{ ...block, citations: null }] }, later[1]])).body.error.message, /Extra inputs/);
    standIn.compaction.refuseReplay = true;
    assert.equal((await next(later)).response.status, 400);

    // A cut-off summary is still a 200, with no block; a gateway may not know the beta at all.
    standIn.compaction.reply = () => ({ stopReason: 'max_tokens' });
    const cut = await post(standIn, BETA, { model: 'claude-opus-5-5', max_tokens: 64, messages: history, compaction: { type: 'summarize' } });
    assert.deepEqual([cut.response.status, cut.body.stop_reason, cut.body.content.length], [200, 'max_tokens', 0]);
    standIn.compaction.knownBeta = false;
    assert.match((await next(later)).body.error.message, /Unexpected value/);
    // An unresolved tool call cannot be summarized.
    standIn.compaction.knownBeta = true;
    standIn.compaction.reply = undefined;
    const pending = [...history, { role: 'user', content: 'Look it up.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] }];
    assert.match((await post(standIn, BETA, { model: 'claude-opus-5-5', max_tokens: 64, messages: pending, compaction: { type: 'summarize' } }))
      .body.error.message, /tool call with no result/);
  } finally {
    await standIn.close();
  }
});
