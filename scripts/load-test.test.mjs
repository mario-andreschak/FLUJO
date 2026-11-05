import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  chatTurn,
  classifyTurn,
  loadTestFlows,
  parseOptions,
  percentile,
  summarizeProbe,
  walkTree,
} from './load-test.mjs';
import { planAnswer, startModelServer } from './load-test/model-server.mjs';

const behaviour = { toolRounds: 1, replyBytes: 100 };

describe('percentile', () => {
  it('uses the nearest rank, and is empty for no values', () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5], 0.95), 5);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
    assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95), 95);
  });
});

describe('classifyTurn', () => {
  it('names each outcome, so an error rate can be read by kind', () => {
    assert.equal(classifyTurn({ status: 200, reply: 'x [nonce:a]' }, 'a'), 'ok');
    assert.equal(classifyTurn({ status: 200, reply: 'x [nonce:b]' }, 'a'), 'wrong_reply');
    assert.equal(classifyTurn({ status: 200, reply: '' }, 'a'), 'empty_reply');
    assert.equal(classifyTurn({ status: 429, code: 'FLOW_RUN_BUSY' }, 'a'), 'http_429:FLOW_RUN_BUSY');
    assert.equal(classifyTurn({ status: 0, error: 'ECONNRESET' }, 'a'), 'transport:ECONNRESET');
    assert.equal(classifyTurn({ status: 200, reply: 'x', code: 'boom' }, 'a'), 'stream_error:boom');
    assert.equal(classifyTurn({ status: 0, cut: true }, 'a'), 'cut_by_client');
  });
});

describe('planAnswer', () => {
  const offered = [{ function: { name: 'srv_echo' } }];

  it('repeats the marker of the last user message, not of an earlier one', () => {
    const plan = planAnswer({ messages: [
      { role: 'user', content: 'old [nonce:first]' },
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'new [nonce:second]' },
    ] }, behaviour);
    assert.equal(plan.kind, 'text');
    assert.ok(plan.text.startsWith('[nonce:second]'));
    assert.ok(!plan.text.includes('first'));
  });

  it('asks for a tool once per user message, then answers', () => {
    const asked = planAnswer({ tools: offered, messages: [{ role: 'user', content: 'go' }] }, behaviour);
    assert.deepEqual([asked.kind, asked.name], ['tool', 'srv_echo']);
    const answered = planAnswer({ tools: offered, messages: [
      { role: 'user', content: 'go' }, { role: 'assistant', content: null }, { role: 'tool', content: 'ok' },
    ] }, behaviour);
    assert.equal(answered.kind, 'text');
    const nextTurn = planAnswer({ tools: offered, messages: [
      { role: 'user', content: 'go' }, { role: 'tool', content: 'ok' }, { role: 'assistant', content: 'done' },
      { role: 'user', content: 'again' },
    ] }, behaviour);
    assert.equal(nextTurn.kind, 'tool');
  });

  it('answers a model decision with a possible answer, in the form FLUJO reads', () => {
    const plan = planAnswer({ messages: [
      { role: 'system', content: 'You make one decision for an automated workflow.\nPossible answers:\n- fine: Anything else\n- needs_person: A person\nReply with only' },
      { role: 'user', content: 'text' },
    ] }, behaviour);
    assert.deepEqual(JSON.parse(plan.text).answer, 'fine');
  });
});

describe('walkTree', () => {
  it('finds children of children, and survives a process listed as its own parent', () => {
    const rows = [
      { pid: 1, parent: 1, name: 'a' }, { pid: 2, parent: 1, name: 'b' },
      { pid: 3, parent: 2, name: 'c' }, { pid: 9, parent: 8, name: 'other' },
    ];
    assert.deepEqual(walkTree(rows, 1).map((row) => row.pid), [2, 3]);
  });
});

describe('summarizeProbe', () => {
  const line = (t, rss, bytes, pid = 1) => ({
    t, pid, rss, heapUsed: rss / 2, external: 0, delayP99Ms: t, delayMaxMs: t * 2, cpuUserMs: t, cpuSystemMs: 0,
    resources: { Timeout: 2 },
    disk: { writes: bytes, bytes, renames: 0, syncs: 0, reads: 0, readBytes: 0 },
    diskByGroup: { 'db/conversations/*.json': { writes: bytes, bytes } },
  });

  it('is empty without measurements', () => {
    assert.equal(summarizeProbe([]), null);
  });

  it('reports what changed in the window, not totals since the server started', () => {
    const summary = summarizeProbe([line(1000, 100, 5000), line(2000, 300, 7000)]);
    assert.equal(summary.disk.writes, 2000);
    assert.equal(summary.diskByGroup['db/conversations/*.json'].bytes, 2000);
    assert.equal(summary.loopDelayMaxMs, 4000);
  });

  it('does not subtract across a restart, when the counters begin again at zero', () => {
    const summary = summarizeProbe([line(1000, 100, 5000, 1), line(2000, 300, 100, 2), line(3000, 300, 400, 2)]);
    assert.equal(summary.disk.writes, 300);
  });
});

describe('parseOptions', () => {
  it('reads flags, numbers and lists', () => {
    const options = parseOptions(['concurrency', '--levels', '10', '--port', '4400', '--retry', '--flows', 'simple']);
    assert.equal(options.scenario, 'concurrency');
    assert.equal(options.levels, '10');
    assert.equal(options.port, 4400);
    assert.equal(options.retry, true);
    assert.equal(options.flows, 'simple');
  });
  it('refuses a stray word', () => {
    assert.throws(() => parseOptions(['faults', 'oops']), /Unexpected argument/);
  });
});

describe('load test flows', () => {
  it('connect only nodes that exist', () => {
    for (const flow of Object.values(loadTestFlows('m', 's'))) {
      const ids = new Set(flow.nodes.map((node) => node.id));
      for (const edge of flow.edges) {
        assert.ok(ids.has(edge.source), `${flow.name}: ${edge.source}`);
        assert.ok(ids.has(edge.target), `${flow.name}: ${edge.target}`);
      }
    }
  });
});

describe('stand-in model over real connections', () => {
  let model;
  const url = () => `http://127.0.0.1:${model.port}`;
  const post = (body) => fetch(`${url()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const control = (update) => fetch(`${url()}/__control`, { method: 'POST', body: JSON.stringify(update) });
  const question = { messages: [{ role: 'user', content: 'hi [nonce:abc]' }] };

  before(async () => { model = await startModelServer({ behaviour: { delayMs: 0, jitterMs: 0, chunkDelayMs: 0 } }); });
  after(async () => { await model.close(); });

  it('answers blocking requests with the marker', async () => {
    const body = await (await post(question)).json();
    assert.match(body.choices[0].message.content, /\[nonce:abc\]/);
  });

  it('streams an answer that ends with the end marker', async () => {
    const text = await (await post({ ...question, stream: true })).text();
    assert.match(text, /\[DONE\]/);
    const joined = text.split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? '').join('');
    assert.match(joined, /\[nonce:abc\]/);
  });

  it('fails, refuses and cuts off on request', async () => {
    await control({ behaviour: { failRate: 1 } });
    assert.equal((await post(question)).status, 500);
    await control({ behaviour: { failRate: 0, rateLimitRate: 1, retryAfterSeconds: 7 } });
    const refused = await post(question);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '7');
    await control({ behaviour: { rateLimitRate: 0, dropRate: 1 } });
    await assert.rejects(() => post(question));
    await control({ reset: true, behaviour: { delayMs: 0, jitterMs: 0, chunkDelayMs: 0 } });
  });

  it('counts a request nobody waits for any more, and frees it', async () => {
    await control({ resetStats: true, behaviour: { hangRate: 1 } });
    const leaving = new AbortController();
    const pending = fetch(`${url()}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify(question), signal: leaving.signal,
    }).catch(() => 'left');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(model.stats().active, 1);
    assert.equal(model.stats().hung, 1);
    leaving.abort();
    assert.equal(await pending, 'left');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(model.stats().active, 0);
    await control({ reset: true, resetStats: true, behaviour: { delayMs: 0, jitterMs: 0, chunkDelayMs: 0 } });
  });
});

describe('chatTurn', () => {
  let target;
  const answers = {};
  before(async () => {
    const { createServer } = await import('node:http');
    target = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => answers.current(response, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  });
  after(async () => {
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  });
  const baseUrl = () => `http://127.0.0.1:${target.address().port}`;
  const turn = (extra) => chatTurn(baseUrl(), { flow: 'f', messages: [], ...extra });

  it('reads a refusal, with the time to wait', async () => {
    answers.current = (response) => {
      response.writeHead(429, { 'Retry-After': '9', 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'FLOW_RUN_BUSY' } }));
    };
    const result = await turn({ stream: false });
    assert.equal(result.status, 429);
    assert.equal(result.retryAfter, '9');
    assert.equal(classifyTurn(result, 'a'), 'http_429:FLOW_RUN_BUSY');
  });

  it('sends the flow name and the conversation in the request', async () => {
    let seen;
    answers.current = (response, body) => {
      seen = body;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    };
    await turn({ stream: false, conversationId: 'c1' });
    assert.equal(seen.model, 'flow-f');
    assert.equal(seen.metadata.conversationId, 'c1');
    assert.equal(seen.metadata.flujo, 'true');
  });

  it('times the first streamed piece apart from the end, and reports a stream error', async () => {
    answers.current = (response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }] })}\n\n`);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ error: { code: 'run_failed' } })}\n\n`);
        response.end('data: [DONE]\n\n');
      }, 150);
    };
    const result = await turn({ stream: true });
    assert.equal(result.reply, 'he');
    assert.equal(result.code, 'run_failed');
    assert.ok(result.totalMs - result.firstAnswerMs >= 100, `${result.firstAnswerMs} ${result.totalMs}`);
  });

  it('hangs up on purpose when told to', async () => {
    let closed;
    const gone = new Promise((resolve) => { closed = resolve; });
    answers.current = (response) => {
      response.once('close', () => closed());
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
    };
    const result = await turn({ stream: true, cut: 'after-first-chunk' });
    assert.equal(result.cut, true);
    assert.equal(classifyTurn(result, 'a'), 'cut_by_client');
    await gone;
  });
});
