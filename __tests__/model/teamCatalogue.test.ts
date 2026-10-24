/** @jest-environment node */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { listTeamModels, resolveTeamModel } from '@/backend/services/model/teamCatalogue';
import { teamModelTransportKey } from '@/shared/types/model/team';
import { teamModelBaseUrl, teamModelId } from '../../packages/shared-controller/src/shared-model';

jest.mock('node:http', () => ({ request: jest.fn() }));
const mockRequest = request as jest.Mock;
const reference = { teamId: 't'.repeat(43), resourceId: 'a'.repeat(43), version: 2, generation: 'e'.repeat(64), teamName: 'Offline team' };
const document = { format: 'flujo.model.v1', model: { name: 'fixture', displayName: 'Fixture', provider: 'ollama', adapter: 'openai',
  baseUrl: 'http://127.0.0.1:1/never-use', promptTemplate: 'Shared prompt', maxTokens: 200 } };
let replies: { status?: number; value: unknown }[];
const previous = { container: process.env.FLUJO_CONTAINER, owner: process.env.FLUJO_OWNER_AUTH_FILE };
beforeEach(() => {
  jest.clearAllMocks(); replies = [];
  process.env.FLUJO_CONTAINER = '1'; process.env.FLUJO_OWNER_AUTH_FILE = '/run/flujo-owner/owner.json';
  mockRequest.mockImplementation((_url, _options, receive) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
    outgoing.end = () => queueMicrotask(() => {
      const reply = replies.shift();
      if (!reply) { outgoing.emit('error', new Error('Fixture connection unavailable')); return; }
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify(reply.value))]), {
        statusCode: reply.status ?? 200, headers: { 'content-type': 'application/json' }, complete: true,
      });
      receive(response);
    });
    return outgoing;
  });
});
afterEach(() => {
  if (previous.container === undefined) delete process.env.FLUJO_CONTAINER; else process.env.FLUJO_CONTAINER = previous.container;
  if (previous.owner === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE; else process.env.FLUJO_OWNER_AUTH_FILE = previous.owner;
});

it('uses the owner relay and materializes a pinned endpoint without decrypting or copying upstream credentials', async () => {
  replies.push({ value: { reference, document } });
  const model = await resolveTeamModel(teamModelId(reference));
  expect(model).toMatchObject({ id: teamModelId(reference), name: 'fixture', displayName: 'Fixture · Offline team',
    ApiKey: '', baseUrl: teamModelBaseUrl(reference), promptTemplate: 'Shared prompt', teamModel: reference });
  expect(teamModelTransportKey(model)).toBe('flujo-local-team-relay');
  expect(() => teamModelTransportKey({ ...model, baseUrl: document.model.baseUrl })).toThrow(/invalid/);
  expect(mockRequest.mock.calls[0][0]).toBe(`http://127.0.0.1:4290/teams/${reference.teamId}/${reference.resourceId}/current`);
  expect(mockRequest.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
});

it('paginates selector metadata and discards partial results when a page becomes unavailable', async () => {
  const later = { ...reference, resourceId: 'b'.repeat(43) };
  replies.push({ value: { entries: [{ reference, model: { name: 'first' } }], next: reference.resourceId } },
    { value: { entries: [{ reference: later, model: { name: 'second' } }], next: null } });
  const catalogue = await listTeamModels(); expect(catalogue.unavailable).toBe(false);
  expect(catalogue.models.map(model => model.name)).toEqual(['first', 'second']);
  expect(catalogue.models.every(model => model.ApiKey === '' && model.promptTemplate === undefined)).toBe(true);
  replies.push({ value: { entries: [{ reference, model: { name: 'first' } }], next: reference.resourceId } }, { status: 403, value: {} });
  expect(await listTeamModels()).toEqual({ models: [], unavailable: true });
});

it('rejects identity mismatches and secret-bearing native documents without private fallback', async () => {
  replies.push({ value: { reference: { ...reference, resourceId: 'b'.repeat(43) }, document } });
  await expect(resolveTeamModel(teamModelId(reference))).rejects.toThrow();
  replies.push({ value: { reference, document: { ...document, model: { ...document.model, ApiKey: 'injected' } } } });
  await expect(resolveTeamModel(teamModelId(reference))).rejects.toThrow();
});

it('leaves ordinary installations local and never contacts the controller relay', async () => {
  delete process.env.FLUJO_CONTAINER;
  expect(await listTeamModels()).toEqual({ models: [], unavailable: false });
  await expect(resolveTeamModel(teamModelId(reference))).rejects.toThrow(/Shared models/);
  expect(mockRequest).not.toHaveBeenCalled();
});
