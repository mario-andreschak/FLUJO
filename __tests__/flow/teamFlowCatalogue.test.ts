import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { assertTeamFlowCurrent, assertTeamFlowModel, assertTeamFlowSnapshot, listTeamFlows, pinnedTeamSubflow,
  projectTeamFlow, resolveTeamFlowBundle, validateTeamFlowBundle } from '@/backend/services/flow/teamCatalogue';
import { teamFlowId, type TeamFlowBundle } from '../../packages/shared-controller/src/shared-flow';

jest.mock('node:http', () => ({ request: jest.fn() }));
const mockRequest = request as jest.Mock;
const reference = { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), version: 1, generation: 'a'.repeat(64), teamName: 'Local team' };
const childId = 'c'.repeat(43);
const childRef = `team-flow:${reference.teamId}:${childId}`;
function fixture(): TeamFlowBundle {
  return { reference, models: [], flows: [
    { resourceId: reference.resourceId, version: 1, document: { format: 'flujo.flow.v1', flow: { name: 'Parent',
      nodes: [{ id: 'call', type: 'subflow', position: { x: 0, y: 0 }, data: { type: 'subflow', label: 'Call', properties: { subflowId: childRef } } }], edges: [] } } },
    { resourceId: childId, version: 1, document: { format: 'flujo.flow.v1', flow: { name: 'Child', nodes: [], edges: [] } } },
  ] };
}
let replies: { status?: number; value: unknown }[];
const previous = { container: process.env.FLUJO_CONTAINER, owner: process.env.FLUJO_OWNER_AUTH_FILE };
beforeEach(() => {
  jest.clearAllMocks(); replies = [];
  process.env.FLUJO_CONTAINER = '1'; process.env.FLUJO_OWNER_AUTH_FILE = '/run/flujo-owner/owner.json';
  mockRequest.mockImplementation((_url, _options, receive) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
    outgoing.end = () => queueMicrotask(() => {
      const reply = replies.shift();
      if (!reply) { outgoing.emit('error', new Error('Fixture unavailable')); return; }
      receive(Object.assign(Readable.from([Buffer.from(JSON.stringify(reply.value))]), {
        statusCode: reply.status ?? 200, headers: { 'content-type': 'application/json' }, complete: true,
      }));
    });
    return outgoing;
  });
});
afterEach(() => {
  if (previous.container === undefined) delete process.env.FLUJO_CONTAINER; else process.env.FLUJO_CONTAINER = previous.container;
  if (previous.owner === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE; else process.env.FLUJO_OWNER_AUTH_FILE = previous.owner;
});

it('resolves only the fixed owner relay and binds child selection to the authored parent slot', async () => {
  replies.push({ value: fixture() });
  const bundle = await resolveTeamFlowBundle(teamFlowId(reference));
  const parent = projectTeamFlow(bundle); const child = pinnedTeamSubflow(parent, 'call', childRef);
  expect(child).toMatchObject({ id: childRef, name: 'Child · Local team', teamFlow: reference });
  expect(mockRequest.mock.calls[0][0]).toBe(`http://127.0.0.1:4290/teams/flows/${reference.teamId}/${reference.resourceId}/current`);
  expect(mockRequest.mock.calls[0][1]).toMatchObject({ method: 'GET', agent: false, headers: { Accept: 'application/json' } });
  expect(() => pinnedTeamSubflow(parent, 'other-node', childRef)).toThrow();
  expect(() => pinnedTeamSubflow(parent, 'call', 'private-child')).toThrow();
  expect(() => pinnedTeamSubflow(parent, 'call', teamFlowId(reference))).toThrow();
  expect(() => assertTeamFlowSnapshot({ ...parent, description: 'changed' }, bundle)).toThrow();
  expect(() => assertTeamFlowSnapshot({ ...parent, teamFlowBundle: { ...bundle, models: [] }, teamFlow: { ...reference, generation: 'b'.repeat(64) } }, bundle)).toThrow();
});

it('rejects identity, closure, cycle and same-team dependency tampering on restored state', async () => {
  const cases: TeamFlowBundle[] = [];
  const missing = fixture(); missing.flows.pop(); cases.push(missing);
  const extra = fixture(); extra.flows.push({ ...extra.flows[1], resourceId: 'e'.repeat(43) }); cases.push(extra);
  const wrongVersion = fixture(); wrongVersion.flows[0].version++; cases.push(wrongVersion);
  const cycle = fixture(); cycle.flows[1].document.flow.nodes = structuredClone(cycle.flows[0].document.flow.nodes); cases.push(cycle);
  const privateBinding = fixture(); privateBinding.flows[0].document.flow.nodes[0].data.properties.subflowId = 'private-flow'; cases.push(privateBinding);
  for (const invalid of cases) expect(() => validateTeamFlowBundle(invalid)).toThrow();
  replies.push({ value: { ...fixture(), reference: { ...reference, resourceId: childId } } });
  await expect(resolveTeamFlowBundle(teamFlowId(reference))).rejects.toThrow();
});

it('pins each prepared model to the dependency grant and never silently accepts a new revision', () => {
  const bundle = fixture(); const modelRef = { teamId: reference.teamId, resourceId: 'm'.repeat(43), generation: 'b'.repeat(64), version: 2 };
  bundle.models = [modelRef];
  const flow = projectTeamFlow(bundle);
  const model = { id: `team-model:${modelRef.teamId}:${modelRef.resourceId}`, name: 'Fixture', ApiKey: '', teamModel: { ...modelRef, teamName: 'Local team' } };
  expect(() => assertTeamFlowModel(flow, model)).not.toThrow();
  expect(() => assertTeamFlowModel(flow, { ...model, teamModel: { ...model.teamModel, version: 3 } })).toThrow();
  expect(() => assertTeamFlowModel(flow, { ...model, teamModel: undefined })).toThrow();
});

it('discards partial catalogues on outage and rechecks the exact generation without a stored fallback', async () => {
  replies.push({ value: { entries: [{ reference, name: 'Shared' }], next: reference.resourceId } }, { status: 403, value: {} });
  expect(await listTeamFlows()).toEqual({ flows: [], unavailable: true });
  replies.push({ value: { reference } }); await assertTeamFlowCurrent(reference);
  expect(mockRequest.mock.calls.at(-1)?.[0]).toBe(`http://127.0.0.1:4290/teams/flows/${reference.teamId}/${reference.resourceId}/current/${reference.generation}`);
  replies.push({ status: 403, value: {} }); await expect(assertTeamFlowCurrent(reference)).rejects.toThrow();
  delete process.env.FLUJO_CONTAINER; mockRequest.mockClear();
  expect(await listTeamFlows()).toEqual({ flows: [], unavailable: false });
  await expect(resolveTeamFlowBundle(teamFlowId(reference))).rejects.toThrow(); expect(mockRequest).not.toHaveBeenCalled();
});
