import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startActionLedger, ACTION_IDS } from './compaction-action-ledger.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const directory = process.env.COMPACTION_LEDGER_TEST_DIR;
assert(directory, 'Set a private owned COMPACTION_LEDGER_TEST_DIR; cleanup uses flujo-bash');

test('external observations expose only happened rounds and every read stays visible', async () => {
  const observations = Array.from({ length: 11 }, (_, round) => `Source round ${round}: autorización no concedida, destino ñ-${round}`);
  const ledger = await startActionLedger({ directory: path.join(directory, randomUUID()), repo, observations });
  const client = new Client({ name: 'compaction-external-observation-control', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(ledger.url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + ledger.token } },
    }));
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'read_observation' && tool.annotations.readOnlyHint));
    const read = round => client.callTool({ name: 'read_observation', arguments: { round } });
    assert.equal((await read(0)).content[0].text, observations[0]);
    const future = await read(1);
    assert.equal(future.isError, true);
    assert(!JSON.stringify(future).includes('ñ-1'));
    assert.throws(() => ledger.setObservationRound(2));
    ledger.setObservationRound(1);
    assert.equal((await read(1)).content[0].text, observations[1]);
    assert.equal((await read(0)).content[0].text, observations[0]);
    const state = await ledger.snapshot();
    assert.equal(state.rows.length, 0, 'Observations cannot commit a local action');
    assert.deepEqual(state.calls.map(call => [call.tool, call.round]),
      [['read_observation', 0], ['read_observation', 1], ['read_observation', 1], ['read_observation', 0]]);
    assert.equal(state.calls[1].result.isError, true, 'The failed future read cannot be erased from evidence');
  } finally {
    await client.close();
    await ledger.close();
  }
});

for (const operation of ['abort request', 'close server']) {
  test('fsynced pending acknowledgement survives ' + operation, { timeout: 15000 }, async () => {
    const ledger = await startActionLedger({ directory: path.join(directory, randomUUID()), repo,
      parallelBatch: true, holdAcknowledgement: true });
    const client = new Client({ name: 'compaction-ledger-negative-control', version: '1.0.0' });
    let pending, closed = false;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ledger.url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + ledger.token } },
      }));
      const controller = new AbortController();
      const first = client.callTool({ name: 'commit_action', arguments: { actionId: ACTION_IDS[0] } });
      pending = client.callTool({ name: 'commit_action', arguments: { actionId: ACTION_IDS[1] } }, undefined,
        { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
      await ledger.heldAcknowledgement;
      await first;
      const before = await ledger.snapshot();
      assert.equal(before.rows.length, 2);
      assert.equal(before.calls.length, 2);
      const held = before.calls.find(call => call.actionId === ACTION_IDS[1]);
      assert.equal(held.acknowledgement, 'held-after-fsync');
      assert(!held.result);
      if (operation === 'abort request') {
        controller.abort(new Error('Controlled user cancellation'));
        assert((await pending).error, 'Client must actually abort while the row is already durable');
        ledger.releaseAcknowledgement();
        const result = await client.callTool({ name: 'lookup_action', arguments: { actionId: ACTION_IDS[1] } });
        const observation = JSON.parse(result.content[0].text);
        assert.equal(observation.count, 1);
        assert.equal(observation.receipts[0].receiptId, before.rows.find(row => row.actionId === ACTION_IDS[1]).receiptId);
        // A deliberate repeated invocation MUST append another row. This
        // negative control prevents idempotency from hiding an application bug.
        await client.callTool({ name: 'commit_action', arguments: { actionId: ACTION_IDS[0] } });
        const after = await ledger.snapshot();
        assert.equal(after.rows.length, 3);
        assert.equal(after.rows.filter(row => row.actionId === ACTION_IDS[0]).length, 2);
      } else {
        await ledger.close();
        closed = true;
        await pending;
        const after = await ledger.snapshot();
        assert.deepEqual(after.rows, before.rows);
        assert.equal(after.fileSha256, before.fileSha256);
        assert.equal(after.calls.find(call => call.actionId === ACTION_IDS[1]).acknowledgement, 'suppressed-after-fsync');
      }
    } finally {
      ledger.releaseAcknowledgement();
      await client.close();
      await pending;
      if (!closed) await ledger.close();
    }
  });
}
