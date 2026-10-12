import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { makeMcpAppClient } from '../src/frontend/components/Chat/mcpAppClient.ts';

async function connect(t, backend, onAccessRevoked = () => {}, onToolResult) {
  const client = makeMcpAppClient('owned-server', 'run:host-owner', onAccessRevoked, backend);
  const bridge = new AppBridge(client, { name: 'FLUJO regression host', version: '1.0.0' }, {
    serverTools: {}, serverResources: {},
  });
  const app = new App({ name: 'Regression View', version: '1.0.0' }, {}, { autoResize: false });
  if (onToolResult) app.ontoolresult = onToolResult;
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await app.close(); await bridge.close(); });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  return { app, bridge };
}

test('real SDK2 AppBridge forwards tools and resources through the host-bound client', async t => {
  const calls = [];
  const reads = [];
  const { app } = await connect(t, {
    callToolFromApp: async (...args) => {
      calls.push(args);
      return { success: true, data: { content: [], structuredContent: { marker: 'real-bridge', value: 42 } } };
    },
    readResourceFromApp: async (...args) => {
      reads.push(args);
      return { success: true, data: { contents: [{ uri: 'fixture://receipt', text: 'resource receipt' }] } };
    },
  });
  const toolResult = await app.callServerTool({ name: 'echo', arguments: { marker: 'receipt' } });
  assert.deepEqual(toolResult.structuredContent, { marker: 'real-bridge', value: 42 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['owned-server', 'echo', { marker: 'receipt' }, undefined]);
  assert.ok(calls[0][4] instanceof AbortSignal);
  assert.equal(calls[0][5], 'run:host-owner');
  const resource = await app.readServerResource({ uri: 'fixture://receipt' });
  assert.equal(resource.contents[0].text, 'resource receipt');
  assert.deepEqual(reads[0].slice(0, 2), ['owned-server', 'fixture://receipt']);
  assert.ok(reads[0][2] instanceof AbortSignal);
});

test('real SDK2 tool-result notifications preserve JSON structuredContent', async t => {
  let received;
  const { bridge } = await connect(t, {
    callToolFromApp: async () => ({ success: true, data: { content: [] } }),
    readResourceFromApp: async () => ({ success: true, data: { contents: [] } }),
  }, undefined, result => received(result));
  for (const structuredContent of [null, ['scene-1', 'scene-2'], 42, 'ready', true]) {
    const delivered = new Promise(resolve => { received = resolve; });
    await bridge.sendToolInput({ arguments: { marker: 'notification' } });
    await bridge.sendToolResult({ structuredContent });
    assert.deepEqual((await delivered).structuredContent, structuredContent);
  }
});

for (const method of ['tool', 'resource']) {
  test(`real SDK2 cancellation reaches the ${method} backend adapter`, { timeout: 5000 }, async t => {
    let started;
    let aborted;
    const sawStart = new Promise(resolve => { started = resolve; });
    const sawAbort = new Promise(resolve => { aborted = resolve; });
    const holdUntilAbort = signal => new Promise((resolve, reject) => {
      assert.ok(signal instanceof AbortSignal);
      started();
      signal.addEventListener('abort', () => {
        aborted();
        reject(new Error('Backend request cancelled'));
      }, { once: true });
    });
    const { app } = await connect(t, {
      callToolFromApp: async (_server, _tool, _args, _meta, signal) => holdUntilAbort(signal),
      readResourceFromApp: async (_server, _uri, signal) => holdUntilAbort(signal),
    });
    const controller = new AbortController();
    const pending = method === 'tool'
      ? app.callServerTool({ name: 'wait', arguments: {} }, { signal: controller.signal })
      : app.readServerResource({ uri: 'fixture://wait' }, { signal: controller.signal });
    // Register rejection before aborting to avoid an unhandled rejection race.
    const rejected = assert.rejects(pending);
    await sawStart;
    controller.abort('User stopped the request');
    await rejected;
    await sawAbort;
  });
}

test('real SDK2 tool errors allow retry and consent revocation reaches the host', async t => {
  let attempt = 0;
  const revocations = [];
  const { app } = await connect(t, {
    callToolFromApp: async () => {
      attempt += 1;
      if (attempt === 1) return { success: false, error: 'Temporary tool failure', httpStatus: 500 };
      if (attempt === 2) return { success: true, data: { content: [{ type: 'text', text: 'Retry receipt' }] } };
      return { success: false, error: 'Apps access disabled', httpStatus: 403 };
    },
    readResourceFromApp: async () => ({ success: true, data: { contents: [] } }),
  }, message => revocations.push(message));
  await assert.rejects(app.callServerTool({ name: 'echo', arguments: {} }), /Temporary tool failure/);
  assert.deepEqual(revocations, []);
  const retried = await app.callServerTool({ name: 'echo', arguments: {} });
  assert.equal(retried.content[0].text, 'Retry receipt');
  await assert.rejects(app.callServerTool({ name: 'echo', arguments: {} }), /Apps access disabled/);
  assert.deepEqual(revocations, ['Apps access disabled']);
});
