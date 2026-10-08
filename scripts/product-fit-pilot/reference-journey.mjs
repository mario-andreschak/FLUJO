import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeatureBrowserEnvironment } from '../feature-surface-acceptance/browser-environment.mjs';
import { REFERENCE_RECEIPT_URI, REFERENCE_TOOLS } from './reference-data.mjs';
import { checkReferenceResult } from './reference-check.mjs';

// Actual app requests with test-authored answers; no provider or model dispatch.
const applicationRoot = process.env.FEATURE_BROWSER_APP_DIR;
if (!applicationRoot) throw new Error('Set FEATURE_BROWSER_APP_DIR to the compiled app.');
const environment = await createFeatureBrowserEnvironment({ applicationRoot, initialConnections: 'ui' });
const reports = [];
try {
  const name = 'Product fit reference';
  await environment.configureServers({ [name]: { name, transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./reference-server.mjs', import.meta.url))], env: {}, disabled: false,
    enableMcpApps: false, rootPath: environment.dataDir, cwd: environment.dataDir, _buildCommand: '', _installCommand: '' } });
  const route = `/api/mcp/servers/${encodeURIComponent(name)}`;
  const listed = await environment.request(`${route}/tools`);
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), REFERENCE_TOOLS.map(tool => tool.name).sort());
  const receipt = async () => {
    const response = await environment.request(`${route}/resources/read?uri=${encodeURIComponent(REFERENCE_RECEIPT_URI)}`);
    assert.equal(response.success, true);
    return JSON.parse(response.data.contents[0].text);
  };
  const initial = await receipt();
  assert.equal(initial.toolCalls, 0);
  const scenarios = [
    ['inbox-triage', [['product_fit_inbox', { queue: 'weekly' }]], { ids: ['notice-02', 'notice-05'] }],
    ['document-check', [['product_fit_document', { document: 'overview' }], ['product_fit_document', { document: 'deployment' }]],
      { differences: [{ field: 'minimumNodeMajor', overview: 22, deployment: 20 }] }],
    ['page-compare', [['product_fit_page', { page: 'catalog' }], ['product_fit_page', { page: 'status' }]], { ids: ['green-kit'] }],
  ];
  for (const [workflow, calls, expected] of scenarios) {
    const toolResults = [];
    for (const [tool, args] of calls) {
      const response = await environment.request(`${route}/tools/${tool}`, { args });
      assert.equal(response.success, true);
      assert.notEqual(response.data.isError, true);
      toolResults.push(response.data.structuredContent ?? JSON.parse(response.data.content[0].text));
    }
    const fixtureReceipt = await receipt();
    assert.equal(fixtureReceipt.runId, initial.runId);
    const packet = { schemaVersion: 1, workflow, fixtureReceipt, toolResults,
      answer: { ...expected, receiptPhrases: toolResults.map(result => result.receiptPhrase) } };
    const report = checkReferenceResult(packet);
    assert.equal(report.result, 'pass');
    reports.push(report);
    await fs.writeFile(path.join(environment.dataDir, `${workflow}.json`), JSON.stringify(packet, null, 2));
  }
  const final = await receipt();
  assert.equal(final.toolCalls, 5);
  assert.equal(final.acceptedCalls, 5);
  assert.equal(final.rejectedCalls, 0);
  await environment.verifyServerSelection();
} finally {
  await environment.close();
  await fs.writeFile(path.join(environment.dataDir, 'reference-journey.json'), JSON.stringify({
    synthetic: true, answerOrigin: 'test-authored', reports, environment: environment.snapshot(),
    claims: { modelReply: false, humanObservation: false, recurringBenefit: false, installedArtifact: false },
  }, null, 2));
  console.log(JSON.stringify({ reports, retainedDirectory: environment.dataDir }));
}
