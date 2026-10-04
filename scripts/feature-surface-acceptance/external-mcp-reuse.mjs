import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFINITION_SHA256 } from './fixture-server.mjs';
import { boundedJson, digest, loopbackOrigin, ownerRequest } from './live-journey-observer.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['base-url', 'workspace', 'server-name',
  'fixture-url', 'candidate-receipt-sha256', 'output-dir'].map(name => [name, { type: 'string' }])) });
for (const name of ['base-url', 'workspace', 'server-name', 'fixture-url', 'candidate-receipt-sha256', 'output-dir']) {
  if (!values[name]) throw new Error(`Missing --${name}. See live-journey.md.`);
}
if (!/^[a-f0-9]{64}$/.test(values['candidate-receipt-sha256'])) throw new Error('Expected an owner candidate receipt SHA-256.');
const baseURL = loopbackOrigin(values['base-url']);
const fixtureOrigin = loopbackOrigin(values['fixture-url']);
const request = ownerRequest(baseURL, values.workspace);
const output = path.resolve(values['output-dir']);
await fs.mkdir(output, { recursive: false });
const signal = AbortSignal.timeout(60000);
const report = { schemaVersion: 1, startedAtUtc: new Date().toISOString(), status: 'incomplete',
  scope: 'Actual external MCP client reuse of the UI-saved HTTP/SSE fixture connection',
  candidateReceiptSha256: values['candidate-receipt-sha256'], sourceArtifactCorrespondence: 'not_verified_by_client',
  baseURL, workspace: values.workspace, serverName: values['server-name'],
  configWrittenByClient: false, processLaunchedByClient: false, credentialsTransferredByClient: false,
  providerToolAcceptance: 'not_evaluated', fullFeatureAcceptance: false, gradeAwarded: false };
const fixtureReceipt = async () => {
  const response = await fetch(`${fixtureOrigin}/receipt`, { redirect: 'error', signal });
  if (!response.ok) throw new Error('Fixture receipt unavailable.');
  return boundedJson(response, 256 * 1024);
};
const client = new Client({ name: 'flujo-feature-external-reuse', version: '1.0.0' }, { capabilities: {} });
let failed;
try {
  const configs = await boundedJson(await request('/api/mcp/servers', { signal }));
  const saved = Array.isArray(configs) && configs.find(config => config.name === values['server-name']);
  if (!saved || saved.disabled === true || !['streamable', 'sse'].includes(saved.transport)
    || saved.serverUrl !== `${fixtureOrigin}${saved.transport === 'sse' ? '/sse' : '/mcp'}`) {
    throw new Error('The owner must create and save the exact selected HTTP/SSE fixture connection through the UI.');
  }
  report.savedTransport = saved.transport;
  report.fixtureBefore = await fixtureReceipt();
  if (report.fixtureBefore.definitionSha256 !== DEFINITION_SHA256 || report.fixtureBefore.mode !== 'normal') {
    throw new Error('Use the selected owned feature fixture in normal mode.');
  }
  const proxy = new URL(`/mcp-proxy/${encodeURIComponent(values['server-name'])}`, baseURL);
  proxy.searchParams.set('workspace', values.workspace);
  await client.connect(new StreamableHTTPClientTransport(proxy), { timeout: 15000, signal });
  const tools = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000, signal });
    tools.push(...page.tools.map(tool => tool.name));
    cursor = page.nextCursor;
    if (cursor && (seenCursors.has(cursor) || seenCursors.size >= 8)) throw new Error('Proxy pagination did not terminate.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  const expected = Array.from({ length: 128 }, (_, index) => `fixture_tool_${String(index + 1).padStart(3, '0')}`);
  if (JSON.stringify(tools) !== JSON.stringify(expected)) throw new Error('External client did not discover all128 fixture tools in order.');
  const afterDiscovery = await fixtureReceipt();
  if (afterDiscovery.runId !== report.fixtureBefore.runId || afterDiscovery.toolCalls !== report.fixtureBefore.toolCalls) {
    throw new Error('Discovery changed the fixture run or dispatched a tool.');
  }
  const args = { element: 'External MCP reuse receipt', ref: randomUUID(), enabled: false };
  report.argumentsSha256 = digest(JSON.stringify(args));
  const result = await client.callTool({ name: 'fixture_tool_128', arguments: args }, undefined, { timeout: 15000, signal });
  report.fixtureAfter = await fixtureReceipt();
  const echo = result.structuredContent;
  const receipt = report.fixtureAfter.recentCalls.at(-1);
  if (result.isError || echo?.toolName !== 'fixture_tool_128' || digest(JSON.stringify(echo.arguments)) !== report.argumentsSha256
    || report.fixtureAfter.runId !== report.fixtureBefore.runId
    || report.fixtureAfter.definitionSha256 !== report.fixtureBefore.definitionSha256
    || report.fixtureAfter.toolCalls !== report.fixtureBefore.toolCalls + 1
    || report.fixtureAfter.acceptedCalls !== report.fixtureBefore.acceptedCalls + 1
    || receipt.sequence !== report.fixtureAfter.toolCalls || receipt.toolName !== 'fixture_tool_128'
    || receipt.accepted !== true || receipt.argumentsSha256 !== report.argumentsSha256) {
    throw new Error('External MCP call, echo and owned fixture receipt did not agree.');
  }
  report.discoveredToolCount = tools.length;
  report.resultSha256 = digest(JSON.stringify(result));
  report.status = 'component_passed';
} catch (error) {
  failed = error;
  report.failure = { name: error instanceof Error ? error.name : 'Error',
    message: 'External reuse incomplete; inspect the selected owner runtime separately.' };
} finally {
  try { await client.close(); report.clientClosed = true; }
  catch { failed ??= new Error('External client did not close.'); report.clientClosed = false; report.status = 'incomplete'; }
  report.completedAtUtc = new Date().toISOString();
  await fs.writeFile(path.join(output, 'external-mcp-reuse.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, report: path.join(output, 'external-mcp-reuse.json'),
  fullFeatureAcceptance: false, gradeAwarded: false }));
if (failed) process.exitCode = 1;
