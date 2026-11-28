/**
 * The official MCP conformance suite (@modelcontextprotocol/conformance, pinned) checks
 * FLUJO as an MCP client. Every client scenario that the frozen 2026-07-28 requirement
 * set lists runs against FLUJO's real code: the conformance tool starts its own servers
 * (authorization and MCP), launches fixtures/conformanceClientBridge.mjs as "the client",
 * and the bridge hands the scenario back to this test. Here FLUJO connects with its own
 * client and transport factories, signs in through its real routes with a headless
 * browser, and uses what the server offers. The tool's own checks decide.
 *
 * Sign-in scenarios run in three legs: the v2 client at 2026-07-28 and at 2025-11-25, and
 * the v1 client at 2025-11-25 (the v1 SDK speaks only the dated protocols up to
 * 2025-11-25). The request scenarios (headers, request state, _meta) are 2026-07-28 only,
 * so only the v2 client takes them. A scenario the tool skips writes no checks and fails.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { disconnectServer: jest.fn(async () => ({ success: true })), getClient: () => undefined },
}));

import { isAuthRequiredError, isOAuthAuthenticationError } from '@/utils/mcp/utils';
import { connectWithFlujo, signIn, storeConfig, streamableServer, type ClientGeneration } from '../utils/mcpOAuthHarness';

jest.setTimeout(120_000);

const repositoryRoot = path.resolve(__dirname, '..', '..');
const conformanceRoot = path.join(repositoryRoot, 'node_modules', '@modelcontextprotocol', 'conformance');
const conformanceCli = path.join(conformanceRoot, 'dist', 'index.js');
const fixtures = path.join(__dirname, 'fixtures');
/** FLUJO's address in these runs; it has no hosted client metadata document of its own. */
const origin = 'http://localhost:4300';
/** The client ID metadata document the basic-cimd scenario expects an operator to publish. */
const CONFORMANCE_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';
/** More than the suite's limit of three, so a FLUJO that keeps asking fails its check. */
const MAX_SIGN_INS = 6;

const requirements = parseYaml(readFileSync(path.join(conformanceRoot, 'requirements', '2026-07-28.yaml'), 'utf8')) as { client: string[] };
const authorizationScenarios = requirements.client.filter((scenario) => scenario.startsWith('auth/'));
const requestScenarios = requirements.client.filter((scenario) => !scenario.startsWith('auth/'));

interface ScenarioRequest {
  serverUrl: string; scenario: string; protocolVersion?: string;
  context?: { client_id?: string; client_secret?: string; issuer?: string };
}
interface Check { id: string; status: string; description?: string; errorMessage?: string }

let privateProfile: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let driver: Server;
let driverUrl: string;
let runScenario: ((request: ScenarioRequest) => Promise<void>) | undefined;
const openClients: Client[] = [];

beforeAll(async () => {
  privateProfile = await installPrivateProfileFixture();
  driver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const run = runScenario;
      const finish = (result: { exitCode: number; error?: string }) => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      };
      if (!run) { finish({ exitCode: 1, error: 'No scenario is expected right now' }); return; }
      run(JSON.parse(body) as ScenarioRequest)
        .then(() => finish({ exitCode: 0 }), (error: unknown) => finish({ exitCode: 1, error: error instanceof Error ? error.stack ?? error.message : String(error) }))
        .finally(() => Promise.allSettled(openClients.splice(0).map((client) => client.close())));
    });
  });
  await new Promise<void>((resolve) => driver.listen(0, '127.0.0.1', resolve));
  driverUrl = `http://127.0.0.1:${(driver.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => driver?.close(resolve));
  await privateProfile?.restore();
});

interface JsonSchema { type?: string; properties?: Record<string, JsonSchema>; required?: string[] }

/** The Tool Tester's way of filling a form: every required field gets a plain value. */
function sampleArguments(schema: JsonSchema | undefined, text: string): Record<string, unknown> {
  const sample = (field: JsonSchema | undefined): unknown => {
    switch (field?.type) {
      case 'number': case 'integer': return 2;
      case 'boolean': return true;
      case 'array': return [];
      case 'object': return sampleArguments(field, text);
      default: return text;
    }
  };
  return Object.fromEntries((schema?.required ?? []).map((key) => [key, sample(schema?.properties?.[key])]));
}

const hasTextField = (schema: JsonSchema | undefined): boolean => Object.values(schema?.properties ?? {})
  .some((field) => field.type === 'string' || (field.type === 'object' && hasTextField(field)));

/** Use everything the server offers, one item at a time; a failing item does not stop the rest. */
async function tryEverything(client: Client): Promise<unknown[]> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { failures.push(error); } };
  const capabilities = client.getServerCapabilities() ?? {};
  if (capabilities.tools) {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as JsonSchema;
      await attempt(() => client.callTool({ name: tool.name, arguments: sampleArguments(schema, 'conformance') }));
      // People also type accents; text outside plain ASCII travels differently in headers.
      if (hasTextField(schema)) await attempt(() => client.callTool({ name: tool.name, arguments: sampleArguments(schema, 'Bogotá café') }));
    }
  }
  if (capabilities.resources) {
    const { resources } = await client.listResources();
    for (const resource of resources) await attempt(() => client.readResource({ uri: resource.uri }));
  }
  if (capabilities.prompts) {
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      const args = Object.fromEntries((prompt.arguments ?? []).filter((arg) => arg.required).map((arg) => [arg.name, 'conformance']));
      await attempt(() => client.getPrompt({ name: prompt.name, arguments: args }));
    }
  }
  return failures;
}

/**
 * What a person does in FLUJO: connect, select Authenticate whenever FLUJO says the
 * server needs a sign-in, and use what the server offers once connected.
 */
async function actLikeAPerson(generation: ClientGeneration, request: ScenarioRequest): Promise<void> {
  const name = `conformance ${generation} ${request.protocolVersion} ${request.scenario}`;
  const preRegistered = request.context?.client_id
    ? { oauthClientId: request.context.client_id, oauthClientSecret: request.context.client_secret, oauthIssuer: request.context.issuer }
    : {};
  await storeConfig(streamableServer(name, request.serverUrl, preRegistered));
  for (let signIns = 0; ; signIns += 1) {
    let failure: unknown;
    try {
      const client = await connectWithFlujo(name, generation, openClients);
      const failures = await tryEverything(client);
      failure = failures.find((error) => isOAuthAuthenticationError(error) || isAuthRequiredError(error)) ?? failures[0];
      if (failure === undefined) return;
    } catch (error) {
      failure = error;
    }
    // Anything but "please sign in" is FLUJO's final answer for this server.
    if (!isOAuthAuthenticationError(failure) && !isAuthRequiredError(failure)) throw failure;
    if (signIns >= MAX_SIGN_INS) throw new Error(`FLUJO asked for a sign-in ${signIns + 1} times`);
    const { initiate, landing } = await signIn(name, origin);
    if (!landing) throw new Error(`Authenticate did not open a sign-in page: ${JSON.stringify(initiate)}`);
    const refused = landing.searchParams.get('oauth_error');
    if (refused) throw new Error(`FLUJO refused the sign-in: ${refused} ${landing.searchParams.get('error_description') ?? ''}`);
  }
}

async function findChecks(folder: string): Promise<Check[] | undefined> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const found = await findChecks(full);
      if (found) return found;
    } else if (entry.name === 'checks.json') {
      return JSON.parse(await readFile(full, 'utf8')) as Check[];
    }
  }
  return undefined;
}

/**
 * Run one scenario through the official tool. Scenarios first listed for 2026-07-28 are
 * run at 2025-11-25 as well (--force): FLUJO applies the same sign-in rules in both client
 * generations, and only the older protocol reaches the v1 client.
 */
async function conformance(scenario: string, specVersion: string, generation: ClientGeneration): Promise<Check[]> {
  const output = await mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-conformance-'));
  const previousMetadataUrl = process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;
  // An operator who publishes their own client ID metadata document configures it like this.
  if (scenario === 'auth/basic-cimd') process.env.FLUJO_OAUTH_CLIENT_METADATA_URL = CONFORMANCE_CLIENT_METADATA_URL;
  runScenario = (request) => actLikeAPerson(generation, request);
  try {
    const child = spawn(process.execPath, [conformanceCli, 'client', '--command', 'node conformanceClientBridge.mjs',
      '--scenario', scenario, '--spec-version', specVersion, '--force', '--timeout', '90000', '--output-dir', output], {
      cwd: fixtures, windowsHide: true,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, FLUJO_CONFORMANCE_DRIVER: driverUrl },
    });
    let printed = '';
    child.stdout.on('data', (chunk) => { printed += chunk; });
    child.stderr.on('data', (chunk) => { printed += chunk; });
    await new Promise((resolve) => child.once('close', resolve));
    const checks = await findChecks(output);
    if (!checks) throw new Error(`The conformance tool wrote no checks for ${scenario}:\n${printed}`);
    return checks;
  } finally {
    runScenario = undefined;
    if (previousMetadataUrl === undefined) delete process.env.FLUJO_OAUTH_CLIENT_METADATA_URL;
    else process.env.FLUJO_OAUTH_CLIENT_METADATA_URL = previousMetadataUrl;
    await rm(output, { recursive: true, force: true });
  }
}

const problems = (checks: Check[]) => checks
  .filter((check) => check.status === 'FAILURE' || check.status === 'WARNING')
  .map((check) => `${check.status} ${check.id}: ${check.errorMessage ?? check.description ?? ''}`);

describe.each([
  ['v2', '2026-07-28'],
  ['v2', '2025-11-25'],
  ['v1', '2025-11-25'],
] as const)('%s client at %s', (generation, specVersion) => {
  it.each(authorizationScenarios)('%s', async (scenario) => {
    const checks = await conformance(scenario, specVersion, generation);
    expect(checks.some((check) => check.status === 'SUCCESS')).toBe(true);
    expect(problems(checks)).toEqual([]);
  });
});

describe('v2 client at 2026-07-28, requests', () => {
  it.each(requestScenarios)('%s', async (scenario) => {
    const checks = await conformance(scenario, '2026-07-28', 'v2');
    expect(checks.some((check) => check.status === 'SUCCESS')).toBe(true);
    expect(problems(checks)).toEqual([]);
  });
});
