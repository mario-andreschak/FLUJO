// What scripts/feature-steps/run.mjs prepares before a step file runs, keyed by the file's name in
// docs/feature-map/steps/. A bullet marked "(needs …)" there must have an entry here whose
// `provides` says, in plain words, what it sets up.
//
// An entry may have:
//   provides  what it sets up (required for "needs" bullets)
//   env       launch settings for the FLUJO the file runs on; values may be functions of { root }
//   before    async ({ baseUrl, dataDir, stub, root, log }) → { route?, cleanup?, ...anything after() needs }
//   after     async ({ baseUrl, dataDir, page, prepared }) → checks what the steps changed, beyond the screen
import { existsSync } from 'node:fs';
import path from 'node:path';
import { STUB_MODEL_ID } from '../first-journey/stub-model.mjs';
import { startStandInRegistry } from './stand-in-registry.mjs';

const WAIT = 120_000;

export async function api(baseUrl, route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(route, baseUrl), {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(WAIT),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export const STUB_MODEL = Object.freeze({ id: 'feature-steps-model', displayName: 'Local stand-in AI' });

/** Connects the local stand-in model, as "AI Setup" would; the built-in FLUJO agent adopts the first one. */
export async function connectStubModel({ baseUrl, stub }) {
  const models = await api(baseUrl, '/api/model');
  if ((Array.isArray(models) ? models : models?.models ?? []).some((model) => model.id === STUB_MODEL.id)) return;
  await api(baseUrl, '/api/model', {
    id: STUB_MODEL.id, name: STUB_MODEL_ID, displayName: STUB_MODEL.displayName, provider: 'openai', adapter: 'openai',
    ApiKey: 'stand-in-key-not-a-secret', baseUrl: stub.url,
  });
}

const node = (id, type, properties = {}, label = `${type} step`) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label, properties } });
const edge = (source, target, edgeType = 'standard') => ({ id: `${source}->${target}`, source, target, type: 'custom', data: { edgeType } });

/** start → AI step on the stand-in model → finish; runnable, so a Persona may use it as its Core Flow. */
export function aiAgent(id, name, extraNodes = [], extraEdges = []) {
  const nodes = [node(`${id}-start`, 'start'), node(`${id}-ai`, 'process', { boundModel: STUB_MODEL.id, inputMode: 'full-history' }, 'Answer'),
    node(`${id}-finish`, 'finish'), ...extraNodes];
  return { id, name, nodes, edges: [edge(`${id}-start`, `${id}-ai`), edge(`${id}-ai`, `${id}-finish`), ...extraEdges] };
}

/** start → finish: the smallest agent FLUJO saves. */
export function plainAgent(id, name) {
  return { id, name, nodes: [node(`${id}-start`, 'start'), node(`${id}-finish`, 'finish')], edges: [edge(`${id}-start`, `${id}-finish`)] };
}

/** An agent whose step asks another agent. */
export function callingAgent(id, name, calls) {
  return {
    id, name,
    nodes: [node(`${id}-start`, 'start'), node(`${id}-call`, 'subflow', { subflowId: calls }, 'Ask another agent'), node(`${id}-finish`, 'finish')],
    edges: [edge(`${id}-start`, `${id}-call`), edge(`${id}-call`, `${id}-finish`)],
  };
}

/** An agent whose AI step uses one Connected App. */
export function appAgent(id, name, server) {
  return aiAgent(id, name, [node(`${id}-app`, 'mcp', { boundServer: server, enabledTools: ['hello'] }, server)], [edge(`${id}-ai`, `${id}-app`, 'mcp')]);
}

const flowById = async (baseUrl, id) => api(baseUrl, `/api/flow/${encodeURIComponent(id)}`).catch(() => null);
const flowStep = (flow, type) => flow?.nodes.find((candidate) => candidate.type === type);

/** The tiny "hello" server of the bundle fixture, connected as a local app that runs in its own folder. */
async function addHelloApp(baseUrl, root, name) {
  const folder = path.join(root, '__tests__/mcp/fixtures/mcpb-hello/server');
  await api(baseUrl, '/api/mcp/servers', {
    name, transport: 'stdio', command: 'node', args: [path.join(folder, 'index.js')], cwd: folder, env: {}, disabled: false,
  });
}

export const SETUPS = {
  'connected-apps-bundle-install.json': {
    async after({ dataDir }) {
      const folder = path.join(dataDir, 'workspaces', 'default-workspace', 'mcp-servers', 'mcpb', 'hello-bundle');
      expect(!existsSync(folder), `Deleting the hello-bundle app left its bundle folder behind: ${folder}`);
    },
  },
  'connected-apps-bundle-signed.json': {
    provides: 'a FLUJO started with NODE_EXTRA_CA_CERTS naming the test signing authority, so the test signature counts as checked',
    env: { NODE_EXTRA_CA_CERTS: ({ root }) => path.join(root, '__tests__/mcp/fixtures/mcpb-signed/test-root-ca.pem') },
  },
  'connected-apps-delete-in-use.json': {
    provides: 'a local app "notes-app" and two agents whose steps use it',
    async before({ baseUrl, stub, root }) {
      await connectStubModel({ baseUrl, stub });
      await addHelloApp(baseUrl, root, 'notes-app');
      await addHelloApp(baseUrl, root, 'notes-app-2');
      await api(baseUrl, '/api/flow', appAgent('notes-helper', 'Notes helper', 'notes-app'));
      await api(baseUrl, '/api/flow', appAgent('notes-reader', 'Notes reader', 'notes-app'));
      return {};
    },
    async after({ baseUrl }) {
      const servers = await api(baseUrl, '/api/mcp/servers');
      const names = (Array.isArray(servers) ? servers : servers?.servers ?? []).map((server) => server.name);
      expect(!names.includes('notes-app'), `"notes-app" is still a Connected App after "Delete app": ${names.join(', ')}`);
      const helper = flowStep(await flowById(baseUrl, 'notes-helper'), 'mcp');
      expect(helper?.data.properties.boundServer === 'notes-app-2', `"Notes helper" should use notes-app-2 now, not ${helper?.data.properties.boundServer}`);
      const reader = flowStep(await flowById(baseUrl, 'notes-reader'), 'mcp');
      expect(!reader?.data.properties.boundServer, `"Notes reader" should be left without an app, but uses ${reader?.data.properties.boundServer}`);
    },
  },
  'agents-system-prompt-run.json': {
    provides: 'the local stand-in model, which the built-in FLUJO agent adopts as its AI',
    async before({ baseUrl, stub }) {
      await connectStubModel({ baseUrl, stub });
      return {};
    },
  },
  'agents-delete-in-use.json': {
    provides: 'the stand-in model, agents "Research" and "Research v2", an agent "Coordinator" that asks "Research", '
      + 'a switched-on automation "Morning research" that runs it, and a Persona "Jim" made from a Role "Researcher"',
    async before({ baseUrl, stub }) {
      await connectStubModel({ baseUrl, stub });
      await api(baseUrl, '/api/flow', aiAgent('research', 'Research'));
      await api(baseUrl, '/api/flow', aiAgent('research-v2', 'Research v2'));
      await api(baseUrl, '/api/flow', callingAgent('coordinator', 'Coordinator', 'research'));
      const { execution } = await api(baseUrl, '/api/planned-executions', {
        name: 'Morning research', enabled: true, flowId: 'research', prompt: 'Look up what changed overnight.',
        trigger: { type: 'schedule', cron: '0 3 1 1 *' },
      });
      const role = await api(baseUrl, '/v1/roles', { name: 'Researcher', prompt: 'You research topics carefully and report back.' });
      const { persona } = await api(baseUrl, '/v1/personas', { name: 'Jim', roleVersionId: role.currentVersionId, idempotencyKey: 'feature-steps-jim' });
      return { executionId: execution.id, personaId: persona.id };
    },
    async after({ baseUrl, prepared }) {
      for (const id of ['research', 'research-v2']) expect(!(await flowById(baseUrl, id)), `The agent "${id}" still exists after "Delete agent".`);
      const coordinator = flowStep(await flowById(baseUrl, 'coordinator'), 'subflow');
      expect(!coordinator?.data.properties.subflowId, `"Coordinator" should have an empty step now, but asks ${coordinator?.data.properties.subflowId}`);
      const { executions = [] } = await api(baseUrl, '/api/planned-executions');
      const automation = executions.map((entry) => entry.execution ?? entry).find((entry) => entry.id === prepared.executionId);
      expect(automation && automation.enabled === false, 'The automation "Morning research" should be turned off.');
      const { persona } = await api(baseUrl, `/v1/personas/${prepared.personaId}`);
      expect(persona.lifecycleState === 'sleeping', `Jim should be paused (asleep) after his Core Flow was removed, but is ${persona.lifecycleState}.`);
      expect(!persona.composition.coreFlowRef, `Jim should have no Core Flow now, but has ${persona.composition.coreFlowRef}.`);
    },
  },
  'packages-uninstall-in-use.json': {
    provides: 'a package "Feature check helpers" installed from a local stand-in registry, whose agent "Package helper" '
      + 'is asked by an agent "Package user" outside the package',
    async before({ baseUrl }) {
      await api(baseUrl, '/api/flow', plainAgent('package-helper-source', 'Package helper'));
      const built = await api(baseUrl, '/api/packages/build', {
        selection: { flowIds: ['package-helper-source'] },
        metadata: { id: 'feature-check/helpers', name: 'Feature check helpers', version: '1.0.0', description: 'One helper agent.' },
      });
      expect(built.ok && built.json, `The package could not be built: ${(built.errors ?? []).join('; ')}`);
      await api(baseUrl, '/api/flow/package-helper-source', undefined, 'DELETE');
      const registry = await startStandInRegistry(new Map([['feature-check/helpers', JSON.parse(built.json)]]));
      try {
        await api(baseUrl, '/api/registry/settings', { baseUrl: registry.url });
        const installed = await api(baseUrl, '/api/packages/install', { source: 'registry', packageId: 'feature-check/helpers', consentGranted: true });
        const helperId = installed.created?.find((item) => item.type === 'flow')?.id;
        expect(installed.ok && helperId, `The package did not install: ${JSON.stringify(installed.errors ?? installed)}`);
        await api(baseUrl, '/api/flow', callingAgent('package-user', 'Package user', helperId));
        return { helperId, cleanup: () => registry.close() };
      } catch (error) {
        await registry.close();
        throw error;
      }
    },
    async after({ baseUrl, prepared }) {
      expect(!(await flowById(baseUrl, prepared.helperId)), 'The package agent "Package helper" still exists after uninstalling.');
      const step = flowStep(await flowById(baseUrl, 'package-user'), 'subflow');
      expect(step?.data.properties.subflowId === 'default-agent-flujo', `"Package user" should ask FLUJO now, but asks ${step?.data.properties.subflowId}`);
    },
  },
};
