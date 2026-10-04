import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReferenceServer } from './reference-server.mjs';
import { REFERENCE_RECEIPT_URI, REFERENCE_DEFINITION_SHA256 } from './reference-data.mjs';
import { checkReferenceResult } from './reference-check.mjs';

const fixturePath = fileURLToPath(new URL('./reference-server.mjs', import.meta.url));
const client = () => new Client({ name: 'reference-protocol-check', version: '1.0.0' });
async function receipt(connection) {
  const result = await connection.readResource({ uri: REFERENCE_RECEIPT_URI });
  assert.equal(result.contents[0].mimeType, 'application/json');
  return JSON.parse(result.contents[0].text);
}

async function checkProtocol(connection) {
  const initial = await receipt(connection);
  assert.equal(initial.toolCalls, 0);
  assert.equal(initial.definitionSha256, REFERENCE_DEFINITION_SHA256);
  const listed = await connection.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['product_fit_inbox', 'product_fit_document', 'product_fit_page']);
  assert.equal(listed.nextCursor, undefined);
  assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint));
  assert.equal((await connection.listResources()).resources[0].uri, REFERENCE_RECEIPT_URI);
  await assert.rejects(connection.readResource({ uri: 'fixture://private-not-a-reference' }), error => {
    assert.ok(!error.message.includes('private-not-a-reference'));
    return /Unknown reference resource/.test(error.message);
  });
  assert.equal((await receipt(connection)).toolCalls, 0, 'Discovery/resource inspection must not invoke tools.');
  const scenarios = [
    ['inbox-triage', [['product_fit_inbox', { queue: 'weekly' }]], { ids: ['notice-02', 'notice-05'] }],
    ['document-check', [['product_fit_document', { document: 'overview' }], ['product_fit_document', { document: 'deployment' }]],
      { differences: [{ field: 'minimumNodeMajor', overview: 22, deployment: 20 }] }],
    ['page-compare', [['product_fit_page', { page: 'catalog' }], ['product_fit_page', { page: 'status' }]], { ids: ['green-kit'] }],
  ];
  for (const [workflow, calls, answer] of scenarios) {
    const results = [];
    for (const [name, args] of calls) {
      const result = await connection.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      results.push(result.structuredContent);
    }
    const current = await receipt(connection);
    const report = checkReferenceResult({ schemaVersion: 1, workflow, fixtureReceipt: current, toolResults: results,
      answer: { ...answer, receiptPhrases: results.map(result => result.receiptPhrase) } });
    assert.equal(report.result, 'pass');
    assert.equal(report.claims.modelOriginVerified, false, 'These answers are test-authored, not model replies.');
  }
  const completed = await receipt(connection);
  assert.equal(completed.runId, initial.runId);
  assert.equal(completed.toolCalls, 5);
  assert.equal(completed.acceptedCalls, 5);
  const invalid = await connection.callTool({ name: 'product_fit_page', arguments: { page: 'catalog', url: 'private-url' } });
  assert.equal(invalid.isError, true);
  assert.ok(!JSON.stringify(invalid).includes('private-url'));
  const rejected = await receipt(connection);
  assert.equal(rejected.toolCalls, 6);
  assert.equal(rejected.acceptedCalls, 5);
  assert.equal(rejected.rejectedCalls, 1);
  assert.ok(!JSON.stringify(rejected).includes('private-url'));
  assert.ok(Object.values(rejected.claims).every(value => value === false));
}

test('installed MCP SDK in-memory protocol: all reference tasks and zero-call discovery', { timeout: 15000 }, async () => {
  const { server } = createReferenceServer();
  const connection = client();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await connection.connect(clientTransport);
    await checkProtocol(connection);
  } finally {
    await connection.close();
    await server.close();
  }
});

test('installed MCP SDK stdio process: actual requests, clean protocol stdout and owned shutdown', { timeout: 15000 }, async () => {
  const connection = client();
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixturePath], stderr: 'pipe' });
  let startup = '';
  let pid;
  transport.stderr?.on('data', chunk => { if (startup.length < 4096) startup += chunk.toString(); });
  try {
    await connection.connect(transport);
    pid = transport.pid;
    await checkProtocol(connection);
    assert.match(startup, /"synthetic":true/);
    assert.match(startup, /"definitionSha256":/);
  } finally {
    await connection.close();
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH',
    'The owned fixture must actually exit after transport close; an acknowledgement is insufficient.');
});
