import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRIAGE_FLOWS = [
  { name: 'ap-32-code-explore', id: 'pkg-software-dev-pkg-softwaredev-cc9947b8-84e1-409f-a17-179846a9' },
  { name: 'ap-11-planning-agent', id: 'pkg-software-dev-pkg-softwaredev-1066b48c-d867-432f-8ce-f959fbe6' },
  { name: 'ap-10-planner-wave', id: 'pkg-software-dev-pkg-softwaredev-512c98bd-51c2-4549-b58-3eaa2a60' },
];
export const READ_FLOW_TOOLS = ['list_flows', 'read_flow', 'list_flow_versions', 'read_flow_version'];
const PRODUCTION_NODE = '5d9354cc-b036-43d3-8dc2-df1fdc960515';
const EXPLORER_GUIDE = `Production workflow discovery (#515): when the brief names a running FLUJO workflow, ap-* flow, planner/security prompt, or deployed configuration, the canonical artifact is the current flow in the requested application workspace. It is not a source file in the software-dev repository. Use the connected read-only FLUJO tools first: list_flows with a focused query, read_flow with the exact name/id, and list_flow_versions/read_flow_version only when history is relevant. Report flow id, node id, updatedAt and the precise prompt/tool/edge evidence. Keep deployment evidence separate from repository revision evidence. Do not declare the canonical artifact missing merely because a repository export is absent. If the flow tool fails, report its exact redacted failure and stop rather than searching unrelated data. Never update/delete/run flows, change schedules, read credentials/global variables, or publish private configuration.\n\n`;
const PLANNER_GUIDE = `Production configuration briefs (#515): preserve a reporter's explicit application/workspace/flow target in the code-explorer handoff. For ap-* workflow or deployed prompt reports, request the current saved flow and node definitions through its read-only FLUJO tools before treating repository exports as a prerequisite. A repository checkout answers code questions; it does not establish the current deployed workflow. Keep credentials and unrelated private configuration out of plans/comments.\n\n`;
const CLOSED_GUIDE = `If the reread shows the issue is already closed or the intake label is absent, it has left this intake queue: do not reopen it, change its closure reason/labels, or post another rejection comment. Return to the remaining OPEN intake issues. Never hand off the same issue twice in this wave; if it reappears after a verified transition or handoff, stop with the exact blocker instead of cycling.\n`;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
export function definitionHash(flow) {
  const definition = structuredClone(flow);
  delete definition.updatedAt;
  return createHash('sha256').update(JSON.stringify(sorted(definition))).digest('hex');
}
function processNode(flow, label) {
  const node = flow.nodes.find(node => node.type === 'process' && node.data?.label === label);
  assert(node?.data?.properties, `Missing expected process node: ${label}`);
  return node;
}
export function repairDefinition(original) {
  const target = TRIAGE_FLOWS.find(target => target.id === original.id);
  assert(target && target.name === original.name, 'Unrecognized canonical workflow identity');
  const flow = structuredClone(original);
  assert(!flow.personaOwnership, 'Persona-owned definitions require their scoped update path');
  if (target.name === 'ap-32-code-explore') {
    const process = processNode(flow, 'Search & read codebase');
    const properties = process.data.properties;
    if (!properties.promptTemplate.includes('Production workflow discovery (#515):')) {
      properties.promptTemplate = EXPLORER_GUIDE + properties.promptTemplate
        .replace('read_text_file / read_multiple_files', 'read_file')
        .replace('filesystem search_files', 'filesystem search');
    }
    const filesystem = flow.nodes.find(node => node.type === 'mcp' && node.data?.properties?.boundServer === 'filesystem');
    assert(filesystem, 'Missing existing filesystem connection');
    filesystem.data.properties.roots = ['./userdata/software-dev/repositories/'];
    const connected = flow.edges.filter(edge => edge.source === process.id).map(edge => edge.target);
    let production = flow.nodes.find(node => connected.includes(node.id) && node.type === 'mcp' && node.data?.properties?.boundServer === 'flujo');
    if (production) {
      assert(production.data.properties.enabledTools.every(tool => READ_FLOW_TOOLS.includes(tool)), 'Existing FLUJO binding includes non-read operations; preserve it for owner review');
      production.data.properties.enabledTools = [...READ_FLOW_TOOLS];
    } else {
      assert(!flow.nodes.some(node => node.id === PRODUCTION_NODE), 'Reserved production reader node id already exists');
      production = {
        id: PRODUCTION_NODE, type: 'mcp',
        position: { x: (filesystem.position?.x ?? 0) + 320, y: filesystem.position?.y ?? 0 },
        data: { label: 'FLUJO: read-only production flows', type: 'mcp', properties: { boundServer: 'flujo', nameIsCustom: true, enabledTools: [...READ_FLOW_TOOLS] } },
      };
      flow.nodes.push(production);
      const template = flow.edges.find(edge => edge.source === process.id && edge.target === filesystem.id);
      assert(template?.data?.edgeType === 'mcp', 'Missing existing MCP configuration edge');
      flow.edges.push({ ...structuredClone(template), id: `${process.id}:process-right-mcp->${production.id}:mcp-left`, target: production.id });
    }
  } else if (target.name === 'ap-11-planning-agent') {
    const properties = processNode(flow, 'Planning Agent: create plan from github issue').data.properties;
    if (!properties.promptTemplate.includes('Production configuration briefs (#515):')) properties.promptTemplate = PLANNER_GUIDE + properties.promptTemplate;
    assert(properties.promptTemplate.includes('it does not reject or close issues'), 'Existing planner rejection boundary is missing');
  } else {
    const process = processNode(flow, 'security verification');
    const properties = process.data.properties;
    assert(properties.promptTemplate.includes('state_reason="not_planned"'), 'Existing verified rejection transition is missing');
    const connected = flow.edges.filter(edge => edge.source === process.id).map(edge => edge.target);
    const github = flow.nodes.find(node => connected.includes(node.id) && node.type === 'mcp' && node.data?.properties?.boundServer === 'github-mcp-server');
    assert(github?.data.properties.enabledTools.includes('issue_write'), 'Security verifier has no issue-write authority');
    properties.promptTemplate = properties.promptTemplate.replace('to fetch the issues labeled with', 'with state="OPEN" to fetch only the open issues labeled with');
    properties.promptTemplate = properties.promptTemplate.replace('when specific evidence establishes a malicious/jailbreak attempt.', 'when specific evidence establishes a malicious/jailbreak attempt or a clearly unrelated solicitation for off-repository work. Describe an unrelated solicitation as out of scope, not as proven malicious.');
    if (!properties.promptTemplate.includes('If the reread shows the issue is already closed')) {
      properties.promptTemplate = properties.promptTemplate.replace('Preserve every unrelated current label.', CLOSED_GUIDE + 'Preserve every unrelated current label.');
    }
  }
  return flow;
}

function baseOrigin(value) {
  const base = new URL(value);
  assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Use an explicit loopback application origin');
  return base.origin;
}
export async function repairRuntime({ base = 'http://127.0.0.1:4200', workspace = 'default-workspace', apply = false, outDir, fetchImpl = fetch, expected } = {}) {
  const origin = baseOrigin(base);
  assert(workspace === 'default-workspace', 'This migration is scoped to the established default workspace');
  assert(outDir, 'An owned evidence directory is required');
  if (apply) assert(expected && TRIAGE_FLOWS.every(target => /^[a-f0-9]{64}$/.test(expected[target.id] ?? '')), 'Applying requires the qualified canonical definition hashes');
  await mkdir(outDir, { recursive: true });
  const receipt = { origin, workspace, apply, startedAt: new Date().toISOString(), flows: [] };
  const request = async (pathname, options) => {
    const response = await fetchImpl(`${origin}${pathname}?workspace=${workspace}`, { ...options, signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Application ${options?.method ?? 'GET'} ${pathname} returned ${response.status}`);
    return response.json();
  };
  try {
    for (const target of TRIAGE_FLOWS) {
      const route = `/api/flow/${encodeURIComponent(target.id)}`;
      const original = await request(route);
      const before = definitionHash(original);
      const next = repairDefinition(original);
      const after = definitionHash(next);
      const row = { ...target, before, after, changed: before !== after, status: 'planned' };
      receipt.flows.push(row);
      if (!row.changed) { row.status = 'already-applied'; continue; }
      if (expected) assert(expected[target.id] === before, `Canonical definition changed since qualification: ${target.name}`);
      if (!apply) continue;
      const runs = await request('/api/runs/active');
      assert(Array.isArray(runs.runs) && !runs.runs.some(run => TRIAGE_FLOWS.some(target => target.id === run.flowId) || run.flowId?.startsWith('pkg-software-dev-') || run.flowName?.startsWith('ap-')), 'An ap-* flow is active; preserve its run/lease');
      const schedules = await request('/api/planned-executions');
      assert(Array.isArray(schedules.executions) && !schedules.executions.some(item => item.execution.enabled && (TRIAGE_FLOWS.some(target => target.id === item.execution.flowId) || item.execution.id?.startsWith('pkg-software-dev-') || item.execution.name?.startsWith('ap-'))), 'An ap-* trigger is enabled; preserve scheduler ownership');
      assert(definitionHash(await request(route)) === before, `Canonical flow changed before save: ${target.name}`);
      // A bounded unknown-outcome save is NEVER retried here. One authoritative
      // reread reconciles a committed timeout; a later invocation is idempotent.
      let saveError;
      try { await request(route, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }); }
      catch (error) { saveError = error; }
      const saved = await request(route);
      assert(definitionHash(saved) === after, `Save verification failed: ${target.name}${saveError ? ' (unknown save outcome)' : ''}`);
      row.status = saveError ? 'verified-after-save-error' : 'verified';
      row.updatedAt = saved.updatedAt;
      const versions = await request(`${route}/versions`);
      row.archive = versions;
    }
    receipt.result = 'passed';
    return receipt;
  } catch (error) {
    receipt.result = 'stopped';
    receipt.error = error.message;
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await writeFile(path.join(outDir, apply ? 'runtime-apply.json' : 'runtime-plan.json'), JSON.stringify(receipt, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  assert(args.includes('--out'), 'Pass --out with an owned evidence directory');
  const expected = args.includes('--expected') ? JSON.parse(await readFile(option('--expected'), 'utf8')) : undefined;
  const receipt = await repairRuntime({ apply: args.includes('--apply'), outDir: option('--out'), expected });
  console.log(JSON.stringify({ result: receipt.result, apply: receipt.apply, flows: receipt.flows.map(flow => ({ name: flow.name, id: flow.id, before: flow.before, after: flow.after, changed: flow.changed, status: flow.status, updatedAt: flow.updatedAt })) }, null, 2));
}
