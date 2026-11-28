/**
 * MCP sign-in end to end, with no person and no third-party account.
 *
 * scripts/mcp-oauth-reference-server.mjs runs a local OAuth 2.1 authorization server and
 * an MCP server protected by it, built from the official MCP SDK's server-side handlers.
 * FLUJO's real routes (/api/oauth/initiate, /callback, /reset), its OAuth provider, its
 * encrypted storage and both of its client generations (v1 and v2 transports) go through
 * the whole flow. A headless "browser" follows the authorization redirect back into the
 * callback route, the way a person's browser would after they click Allow.
 *
 * Covered: protected resource metadata, the 401 challenge, client ID metadata documents
 * and dynamic registration, S256 PKCE, resource indicators, the issuer in the redirect,
 * refresh after expiry with rotation, a token endpoint that is down for a moment, a grant
 * the provider revoked, step-up to one more scope, and revocation on sign-out.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
// /api/oauth/reset disconnects the live connection; this test owns its connections itself.
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { disconnectServer: jest.fn(async () => ({ success: true })), getClient: () => undefined },
}));

import { readOAuthTokens } from '@/backend/services/mcp/oauthCredentialStorage';
import { isAuthRequiredError, isOAuthAuthenticationError } from '@/utils/mcp/utils';
import {
  connectWithFlujo, everyStoredFile, flujoRequest, signIn as authenticate, storeConfig, storedConfig, streamableServer,
  type ClientGeneration,
} from '../utils/mcpOAuthHarness';

jest.setTimeout(120_000);

/** Notes are shared by the whole run, so earlier stories may already have written some. */
const NOTES = /^(no notes yet|note \d+)/;
const WRITTEN_NOTE = /^note \d+/;

interface Reference {
  issuer: string; resource: string; control: string; clientMetadataUrl: string;
  process: ChildProcessWithoutNullStreams;
}
interface LogEntry { kind: string; [field: string]: unknown }

const repositoryRoot = path.resolve(__dirname, '..', '..');
let reference: Reference;
let privateProfile: Awaited<ReturnType<typeof installPrivateProfileFixture>>;

beforeAll(async () => {
  privateProfile = await installPrivateProfileFixture();
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'scripts', 'mcp-oauth-reference-server.mjs')],
    { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const line = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) resolve(output.split('\n')[0]);
    });
    child.once('exit', (code) => reject(new Error(`The reference server exited (${code}): ${errors}`)));
  });
  reference = { ...JSON.parse(line), process: child };
});

afterAll(async () => {
  if (reference?.process && reference.process.exitCode === null) {
    const exited = new Promise((resolve) => reference.process.once('exit', resolve));
    reference.process.stdin.end();
    await exited;
  }
  await privateProfile?.restore();
});

async function control(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${reference.control}/${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
}
const referenceLog = async () => await control('log') as LogEntry[];

const openClients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
});
const connect = (name: string, generation: ClientGeneration) => connectWithFlujo(name, generation, openClients);
const store = storeConfig;
const flujo = flujoRequest;

async function callText(client: Client, tool: string): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: {} }) as { content: Array<{ text?: string }>; isError?: boolean };
  expect(result.isError).not.toBe(true);
  return result.content.map((item) => item.text ?? '').join('');
}

/** Authenticate must open a consent page that ends back in FLUJO with success. */
async function signIn(name: string, origin: string): Promise<URL> {
  const { initiate, landing } = await authenticate(name, origin);
  expect(initiate.error).toBeUndefined();
  expect(initiate.authorizationUrl).toEqual(expect.any(String));
  expect(Object.fromEntries(landing!.searchParams)).toMatchObject({ oauth_success: name });
  return new URL(initiate.authorizationUrl!);
}

describe.each([
  ['v2', 'a client ID metadata document', 'http://localhost:4200'],
  ['v1', 'dynamic registration', 'http://localhost:4300'],
  ['v2', 'dynamic registration', 'http://localhost:4300'],
  ['v1', 'a client ID metadata document', 'http://localhost:4200'],
] as const)('%s client with %s (FLUJO at %s)', (generation, registration, origin) => {
  const name = `notes ${generation} ${registration === 'dynamic registration' ? 'dcr' : 'cimd'}`;
  const cimd = registration !== 'dynamic registration';
  let firstRefreshToken: string | undefined;

  it('recognises that the server needs a sign-in', async () => {
    await store(streamableServer(name, reference.resource));
    const error = await connect(name, generation).then(() => undefined, (caught: unknown) => caught);
    expect(isAuthRequiredError(error)).toBe(true);
  });

  it('signs in through the routes and a headless browser, and stores only ciphertext', async () => {
    const before = (await referenceLog()).length;
    const authorizationUrl = await signIn(name, origin);
    const params = authorizationUrl.searchParams;
    expect(authorizationUrl.origin).toBe(reference.issuer);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('resource')).toBe(reference.resource);
    expect(params.get('scope')).toBe('notes:read');
    if (cimd) {
      expect(params.get('client_id')).toBe(reference.clientMetadataUrl);
      expect(params.get('redirect_uri')).toBe(`${origin}/api/oauth/callback`);
    } else {
      expect(params.get('client_id')).not.toBe(reference.clientMetadataUrl);
      expect(params.get('redirect_uri')).toBe(`${origin}/api/oauth/callback?workspace=default-workspace`);
    }

    const log = (await referenceLog()).slice(before);
    const registrations = log.filter((entry) => entry.kind === 'register');
    if (cimd) {
      expect(registrations).toHaveLength(0);
    } else {
      expect(registrations).toEqual([expect.objectContaining({
        applicationType: 'native', grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'client_secret_post', scope: 'notes:read',
      })]);
    }
    expect(log.filter((entry) => entry.kind === 'token')).toEqual([expect.objectContaining({
      grantType: 'authorization_code', resource: reference.resource, scope: 'notes:read',
    })]);

    const config = await storedConfig(name);
    expect(config.oauthTokens).toEqual({ format: 'flujo-oauth-v1', ciphertext: expect.stringMatching(/^v2:/) });
    expect(config.oauthClientInformation).toEqual({ format: 'flujo-oauth-v1', ciphertext: expect.stringMatching(/^v2:/) });
    expect(config.oauthState).toBeUndefined();
    expect(config.oauthCodeVerifier).toBeUndefined();
    const tokens = await readOAuthTokens(config);
    firstRefreshToken = tokens?.refresh_token;
    expect(firstRefreshToken).toEqual(expect.any(String));
    const stored = await everyStoredFile(privateProfile.root);
    expect(stored).toContain(config.oauthTokens && (config.oauthTokens as { ciphertext: string }).ciphertext);
    expect(stored).not.toContain(tokens!.access_token);
    expect(stored).not.toContain(firstRefreshToken);
  });

  it('calls a tool with the access token', async () => {
    const client = await connect(name, generation);
    expect(await callText(client, 'read_note')).toMatch(NOTES);
  });

  it('refreshes an expired access token, keeps the rotated grant, and reuses it after a restart', async () => {
    const client = await connect(name, generation);
    await control('expire-access-tokens', {});
    const before = (await referenceLog()).length;
    expect(await callText(client, 'read_note')).toMatch(NOTES);
    const refreshes = (await referenceLog()).slice(before).filter((entry) => entry.kind === 'token');
    expect(refreshes).toEqual([expect.objectContaining({ grantType: 'refresh_token', resource: reference.resource, outcome: 'issued' })]);
    const rotated = (await readOAuthTokens(await storedConfig(name)))?.refresh_token;
    expect(rotated).toEqual(expect.any(String));
    expect(rotated).not.toBe(firstRefreshToken);

    const restarted = await connect(name, generation);
    const afterRestart = (await referenceLog()).length;
    expect(await callText(restarted, 'read_note')).toMatch(NOTES);
    expect((await referenceLog()).slice(afterRestart).filter((entry) => entry.kind === 'token')).toHaveLength(0);
  });

  it('keeps the sign-in when the token endpoint is down for a moment', async () => {
    const client = await connect(name, generation);
    await control('expire-access-tokens', {});
    await control('fail-token-requests', { count: 1, status: 503 });
    expect(await callText(client, 'read_note')).toMatch(NOTES);

    await control('expire-access-tokens', {});
    await control('fail-token-requests', { count: 50, status: 503 });
    const before = (await referenceLog()).length;
    const outage = await connect(name, generation).then(
      (connected) => callText(connected, 'read_note').then(() => undefined, (caught: unknown) => caught),
      (caught: unknown) => caught,
    );
    expect(outage).toBeInstanceOf(Error);
    // A provider outage is not a reason to sign in again: nothing was thrown away and no
    // new consent page was opened.
    expect(isOAuthAuthenticationError(outage)).toBe(false);
    expect((await referenceLog()).slice(before).filter((entry) => entry.kind === 'authorize')).toHaveLength(0);
    expect((await readOAuthTokens(await storedConfig(name)))?.refresh_token).toEqual(expect.any(String));

    await control('fail-token-requests', { count: 0 });
    const recovered = await connect(name, generation);
    expect(await callText(recovered, 'read_note')).toMatch(NOTES);
  });

  it('asks for one more scope when a tool needs it, and keeps the scope it already had', async () => {
    const client = await connect(name, generation);
    const error = await client.callTool({ name: 'write_note', arguments: {} }).then(() => undefined, (caught: unknown) => caught);
    expect(isOAuthAuthenticationError(error)).toBe(true);

    const authorizationUrl = await signIn(name, origin);
    expect(authorizationUrl.searchParams.get('scope')?.split(' ').sort()).toEqual(['notes:read', 'notes:write']);
    const upgraded = await connect(name, generation);
    expect(await callText(upgraded, 'write_note')).toBe('saved');
    expect(await callText(upgraded, 'read_note')).toMatch(WRITTEN_NOTE);
  });

  it('recovers with a new sign-in when the provider revoked the grant', async () => {
    const client = await connect(name, generation);
    await control('revoke-grants', {});
    const error = await callText(client, 'read_note').then(() => undefined, (caught: unknown) => caught);
    expect(isOAuthAuthenticationError(error)).toBe(true);
    // The dead refresh token is gone, so FLUJO does not keep presenting it.
    expect((await storedConfig(name)).oauthTokens).toBeUndefined();

    await signIn(name, origin);
    const recovered = await connect(name, generation);
    expect(await callText(recovered, 'read_note')).toMatch(WRITTEN_NOTE);
  });

  it('revokes the grant at the provider when the person resets the sign-in', async () => {
    const before = (await control('state') as { grants: Array<{ revoked: boolean }> }).grants.filter((grant) => !grant.revoked).length;
    expect(before).toBeGreaterThan(0);
    const response = await flujo(origin, 'POST', '/api/oauth/reset', { serverName: name });
    expect(await response.json()).toMatchObject({ success: true, revokedAtProvider: true });
    const state = await control('state') as { grants: Array<{ revoked: boolean }> };
    expect(state.grants.filter((grant) => !grant.revoked)).toHaveLength(0);
    expect((await referenceLog()).filter((entry) => entry.kind === 'revoke').at(-1))
      .toMatchObject({ tokenTypeHint: 'refresh_token', known: true });
    expect((await storedConfig(name)).oauthTokens).toBeUndefined();

    await signIn(name, origin);
    expect(await callText(await connect(name, generation), 'read_note')).toMatch(WRITTEN_NOTE);
  });
});
