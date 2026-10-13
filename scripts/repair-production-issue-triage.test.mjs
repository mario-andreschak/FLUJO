import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TRIAGE_FLOWS, READ_FLOW_TOOLS, repairDefinition, repairRuntime, definitionHash } from './repair-production-issue-triage.mjs';

const originals = await Promise.all(TRIAGE_FLOWS.map(target => readFile(new URL(`../docs/audits/evidence/production-issue-triage-515-2026-10-12/canonical-before/${target.name}.json`, import.meta.url), 'utf8').then(JSON.parse)));
const expected = Object.fromEntries(originals.map(flow => [flow.id, definitionHash(flow)]));

test('canonical repair is idempotent and preserves model bindings, legacy tools, ids and unrelated graph nodes', () => {
  for (const original of originals) {
    const result = repairDefinition(original);
    assert.equal(definitionHash(repairDefinition(result)), definitionHash(result));
    assert.equal(original.nodes.find(node => node.type === 'process').data.properties.boundModel, result.nodes.find(node => node.type === 'process').data.properties.boundModel);
    for (const node of original.nodes.filter(node => node.type !== 'process' && node.data?.properties?.boundServer !== 'filesystem')) assert.deepEqual(result.nodes.find(item => item.id === node.id), node);
    assert.equal(result.id, original.id);
    assert.equal(result.folder, original.folder);
  }
  const explorer = repairDefinition(originals[0]);
  assert.deepEqual(explorer.nodes.find(node => node.data?.properties?.boundServer === 'filesystem').data.properties.enabledTools, originals[0].nodes.find(node => node.data?.properties?.boundServer === 'filesystem').data.properties.enabledTools);
  assert.deepEqual(explorer.nodes.find(node => node.data?.properties?.boundServer === 'flujo').data.properties.enabledTools, READ_FLOW_TOOLS);
});

test('refuses unidentified and Persona-owned flows and a missing rejection boundary', () => {
  assert.throws(() => repairDefinition({ ...originals[0], id: 'another-user-flow' }), /identity/);
  assert.throws(() => repairDefinition({ ...originals[0], personaOwnership: {} }), /Persona/);
  const security = structuredClone(originals[2]);
  security.nodes.find(node => node.type === 'process').data.properties.promptTemplate = 'comment and skip';
  assert.throws(() => repairDefinition(security), /transition/);
});

function harness({ active = false, scheduled = false, committedTimeout = false, rejectedSave = false, raced = false } = {}) {
  const flows = new Map(originals.map(flow => [flow.id, structuredClone(flow)]));
  const puts = [];
  const reads = new Map();
  return { flows, puts, fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/runs/active') return Response.json({ runs: active ? [{ flowId: originals[0].id }] : [] });
    if (pathname === '/api/planned-executions') return Response.json({ executions: scheduled ? [{ execution: { enabled: true, id: 'pkg-software-dev-ap-02-produce-plans' } }] : [] });
    if (pathname.endsWith('/versions')) return Response.json([{ versionId: 'before-save', savedAt: 1 }]);
    const id = decodeURIComponent(pathname.slice('/api/flow/'.length));
    if (options.method === 'PUT') {
      puts.push(id);
      if (rejectedSave) throw new Error('write failed before effect');
      flows.set(id, JSON.parse(options.body));
      if (committedTimeout && puts.length === 1) throw new Error('timeout after committed write');
      return Response.json(flows.get(id));
    }
    const count = (reads.get(id) ?? 0) + 1;
    reads.set(id, count);
    if (raced && count === 2) flows.set(id, { ...flows.get(id), description: 'foreign edit' });
    return Response.json(flows.get(id));
  } };
}

async function owned(fn) {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'flujo-515-contract-'));
  try { return await fn(outDir); }
  finally {
    assert(path.resolve(outDir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(outDir).startsWith('flujo-515-contract-'));
    await rm(outDir, { force: true, recursive: true });
  }
}

test('plan performs no writes; apply archives/verifies each update; replay performs no writes', () => owned(async outDir => {
  const service = harness();
  await repairRuntime({ outDir, fetchImpl: service.fetchImpl });
  assert.equal(service.puts.length, 0);
  const applied = await repairRuntime({ apply: true, expected, outDir, fetchImpl: service.fetchImpl });
  assert.equal(service.puts.length, 3);
  assert(applied.flows.every(row => row.status === 'verified' && row.archive[0].versionId === 'before-save'));
  const replayed = await repairRuntime({ apply: true, expected, outDir, fetchImpl: service.fetchImpl });
  assert.equal(service.puts.length, 3);
  assert(replayed.flows.every(row => row.status === 'already-applied'));
}));

for (const flag of ['active', 'scheduled', 'raced']) {
  test(`preserves ${flag} ownership and stops before a write`, () => owned(async outDir => {
    const service = harness({ [flag]: true });
    await assert.rejects(repairRuntime({ apply: true, expected, outDir, fetchImpl: service.fetchImpl }));
    assert.equal(service.puts.length, 0);
    const receipt = JSON.parse(await readFile(path.join(outDir, 'runtime-apply.json'), 'utf8'));
    assert.equal(receipt.result, 'stopped');
  }));
}

test('reconciles a committed timeout with one reread and no duplicate PUT', () => owned(async outDir => {
  const service = harness({ committedTimeout: true });
  const result = await repairRuntime({ apply: true, expected, outDir, fetchImpl: service.fetchImpl });
  assert.equal(result.flows[0].status, 'verified-after-save-error');
  assert.equal(service.puts.length, 3);
}));

test('failed/unknown save stops the batch with evidence and never automatically retries', () => owned(async outDir => {
  const service = harness({ rejectedSave: true });
  await assert.rejects(repairRuntime({ apply: true, expected, outDir, fetchImpl: service.fetchImpl }), /Save verification failed/);
  assert.equal(service.puts.length, 1);
}));

test('requires qualified hashes and refuses non-loopback origins/workspaces', () => owned(async outDir => {
  await assert.rejects(repairRuntime({ outDir, base: 'https://example.com' }), /loopback/);
  await assert.rejects(repairRuntime({ outDir, workspace: 'another-owner' }), /workspace/);
  await assert.rejects(repairRuntime({ outDir, apply: true }), /qualified/);
  const service = harness();
  await assert.rejects(repairRuntime({ outDir, apply: true, expected: Object.fromEntries(TRIAGE_FLOWS.map(target => [target.id, '0'.repeat(64)])), fetchImpl: service.fetchImpl }), /changed since qualification/);
  assert.equal(service.puts.length, 0);
}));
