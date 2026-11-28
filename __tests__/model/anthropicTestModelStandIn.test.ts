/**
 * #1351: the "Test model" button and the model list of an "Anthropic (Native)"
 * model on Anthropic SDK 1.x, against `scripts/anthropic-stand-in.mjs`, a local
 * stand-in of Anthropic's service that refuses what API version 2026-10-21
 * refuses. This replaces the check that needed a real API key: one small request
 * on the new version, a saved Creativity that is kept but never sent, and
 * gateways behind a custom base URL (one that reads only X-Api-Key, one that
 * does not know the new version). The SDK, its HTTP transport and FLUJO's
 * adapter, test and model list code all run for real.
 */
import { API_VERSIONS, REMOVED_SAMPLING_FIELDS, startAnthropicStandIn } from '../../scripts/anthropic-stand-in.mjs';
import { testModelReply } from './fixtures/testModelReplies';
import { __resetApiVersionSupport, __resetCacheControlSupport } from '@/backend/services/model/adapters/anthropicAdapter';
import { testModelConnection } from '@/backend/services/model/testConnection';
import { fetchModelsFromProvider } from '@/backend/services/model/provider';
import type { Model } from '@/shared/types/model/model';

jest.setTimeout(60_000);

type StandIn = Awaited<ReturnType<typeof startAnthropicStandIn>>;
const KEY = 'flujo-stand-in-api-key';
let standIn: StandIn;

beforeAll(async () => {
  standIn = await startAnthropicStandIn({ reply: ({ body }) => testModelReply(body) ?? { blocks: [{ type: 'text', text: 'pong' }] } });
});
afterAll(() => standIn.close());
beforeEach(() => {
  standIn.requests.length = 0;
  standIn.acceptedVersions = [API_VERSIONS.previous, API_VERSIONS.current];
  standIn.refusesCredential = credential => /invalid/i.test(credential.value);
  __resetApiVersionSupport();
  __resetCacheControlSupport();
});

/** A saved "Anthropic (Native)" model, with a Creativity value saved before version 2026-10-21. */
const savedModel = (baseUrl: string): Model => ({
  id: 'saved-claude', name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet', provider: 'anthropic', adapter: 'anthropic',
  baseUrl, ApiKey: '', temperature: '0.7',
} as Model);

const pressTestModel = (baseUrl: string, apiKey = KEY) => testModelConnection({
  modelName: 'claude-sonnet-4-6', baseUrl, apiKey, provider: 'anthropic', adapter: 'anthropic', model: savedModel(baseUrl),
});

const messageRequests = (server: StandIn) => server.requests.filter(request => request.path === '/v1/messages');

describe('#1351: "Test model" for Anthropic (Native) on API version 2026-10-21', () => {
  it('passes the ping and the tool round-trip with the key in X-Api-Key and no sampling field, even with a saved Creativity', async () => {
    const result = await pressTestModel(standIn.baseUrl);
    expect(result).toMatchObject({ ok: true, tool: { ok: true } });
    const requests = messageRequests(standIn);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const request of requests) {
      expect(request).toMatchObject({ status: 200, version: API_VERSIONS.current, apiKeyHeader: true, bearer: false, credential: 'api-key' });
      for (const field of REMOVED_SAMPLING_FIELDS) expect(request.body).not.toHaveProperty(field);
    }
    // The tool round-trip really reached the model: the result went back to it.
    expect(JSON.stringify(requests.at(-1)!.body)).toContain('tool_result');
  });

  it('passes through a gateway behind a custom base URL that reads only X-Api-Key', async () => {
    standIn.refusesCredential = credential => credential.kind !== 'api-key';
    const result = await pressTestModel(standIn.baseUrl);
    expect(result).toMatchObject({ ok: true, tool: { ok: true } });
    expect(messageRequests(standIn).every(request => request.status === 200)).toBe(true);
  });

  it('falls back once to 2023-06-01 for a gateway that does not know the new version, and keeps using it', async () => {
    standIn.acceptedVersions = [API_VERSIONS.previous];
    const result = await pressTestModel(standIn.baseUrl);
    expect(result).toMatchObject({ ok: true, tool: { ok: true } });
    const versions = messageRequests(standIn).map(request => [request.version, request.status]);
    expect(versions[0]).toEqual([API_VERSIONS.current, 400]);
    expect(versions.slice(1).every(([version, status]) => version === API_VERSIONS.previous && status === 200)).toBe(true);
    expect(versions.length).toBeGreaterThanOrEqual(4);
  });

  it('fails with the service\'s own message for a refused key, never a pass', async () => {
    const result = await pressTestModel(standIn.baseUrl, 'invalid-key');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/invalid x-api-key/);
    expect(messageRequests(standIn).every(request => request.status === 401)).toBe(true);
  });

  it('lists the models of an Anthropic connection behind a custom base URL with X-Api-Key and the new version', async () => {
    const models = await fetchModelsFromProvider('anthropic', `${standIn.baseUrl}/v1`, KEY, 'anthropic');
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-haiku-4-5']));
    expect(standIn.requests.at(-1)).toMatchObject({ path: '/v1/models', version: API_VERSIONS.current, apiKeyHeader: true, bearer: false, status: 200 });
  });
});
