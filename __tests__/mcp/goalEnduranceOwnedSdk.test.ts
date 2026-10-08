import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { installTrustedHostProfile } from './fixtures/trustedHostProfile';
import { fingerprintTrustedHostSource, trustedHostMcpPolicySchema } from '@/backend/services/security/trustedHostMcp';
import { createStdioTransport } from '@/backend/services/mcp/connection';
import { getManagedTrustedHost } from '@/backend/services/mcp/trustedHost';

let mockCurrentConfig: MCPStdioConfig | undefined;
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => mockCurrentConfig ? [mockCurrentConfig] : []),
}));

describe('owned endurance fixture through the real SDK transport', () => {
  it('delivers a runner-bound ephemeral token without persisting it and rejects rotation', async () => {
    const token = 'owned-sdk-fixture-ephemeral-token';
    const runId = 'owned-sdk-fixture-run';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-endurance-sdk-'));
    const client = new Client({ name: 'owned-endurance-sdk-control', version: '1.0.0' });
    let ownedService: http.Server | undefined;
    let ownedApproval: ReturnType<typeof installTrustedHostProfile> | undefined;
    let saved: Record<string, string | undefined> = {};
    let failed = false;
    try {
      const agentRoot = path.join(directory, 'agent');
      let authorizedRequests = 0;
      const service = http.createServer((request, response) => {
        if (request.url !== '/research.json' || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401).end();
          return;
        }
        authorizedRequests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ runId, sourceId: 'owned-sdk-research' }));
      });
      ownedService = service;
      await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
      const address = service.address();
      if (!address || typeof address === 'string') throw new Error('Expected an owned HTTP listener');
      const fixtureUrl = `http://127.0.0.1:${address.port}`;
      const approved = installTrustedHostProfile({ name: 'goal-endurance', nodeSource: '// Owned fixture staging.',
        environmentNames: ['PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN'] });
      ownedApproval = approved;
      const policy = trustedHostMcpPolicySchema.parse(approved.config.trustedHost);
      const entryPoint = path.join(policy.sourceRoot, 'public-fixture-mcp.mjs');
      const dependency = createRequire(path.resolve('package.json'));
      const source = fs.readFileSync(path.resolve('scripts/persona-goal-acceptance/public-fixture-mcp.mjs'), 'utf8')
        .replace(/from '(@modelcontextprotocol\/sdk\/[^']+)'/g,
          (_match, specifier: string) => `from ${JSON.stringify(pathToFileURL(dependency.resolve(specifier)).href)}`);
      fs.writeFileSync(entryPoint, source);
      const config: MCPStdioConfig = { ...approved.config, rootPath: process.cwd(), source: { type: 'local' },
        args: [entryPoint, fixtureUrl, agentRoot, runId], trustedHost: { ...policy, entryPoint,
          sourceDigest: fingerprintTrustedHostSource(policy.sourceRoot) } };
      approved.approve(config);
      mockCurrentConfig = config;
      const bindings: Record<string, string> = {
        PERSONA_GOAL_ENDURANCE_PROFILE: 'structured-tools', PERSONA_GOAL_ENDURANCE_FIXTURE_URL: fixtureUrl,
        PERSONA_GOAL_ENDURANCE_AGENT_ROOT: agentRoot, PERSONA_GOAL_ENDURANCE_RUN_ID: runId,
        PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN: token, PERSONA_GOAL_ENDURANCE_FIXTURE_ENTRY: entryPoint,
        PERSONA_GOAL_ENDURANCE_FIXTURE_SOURCE_DIGEST: trustedHostMcpPolicySchema.parse(config.trustedHost).sourceDigest,
      };
      saved = Object.fromEntries(Object.keys(bindings).map(name => [name, process.env[name]]));
      Object.assign(process.env, bindings);
        expect(JSON.stringify(config)).not.toContain(token);
        const transport = createStdioTransport(config);
        await client.connect(transport);
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('research_page');
        const research = await client.callTool({ name: 'research_page', arguments: {} });
        expect(research.isError).not.toBe(true);
        expect(JSON.stringify(research)).toContain('owned-sdk-research');
        expect(authorizedRequests).toBe(1);
        expect(JSON.stringify(config)).not.toContain(token);
        process.env.PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN = 'rotated-runner-token';
        const managed = getManagedTrustedHost(transport);
        expect(managed).toBeDefined();
        await expect(managed!.assertCurrent(config)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
        expect(authorizedRequests).toBe(1);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const failures: unknown[] = [];
      try { await client.close(); } catch (error) { failures.push(error); }
      mockCurrentConfig = undefined;
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }),
        Promise.resolve().then(() => ownedApproval?.restore()),
        new Promise<void>((resolve, reject) => {
          if (!ownedService?.listening) { resolve(); return; }
          ownedService.close(error => error ? reject(error) : resolve());
        }),
        Promise.resolve().then(() => {
          if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
              || !/^flujo-endurance-sdk-[A-Za-z0-9]+$/.test(path.basename(directory))
              || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe owned SDK fixture cleanup');
          fs.rmSync(directory, { recursive: true, force: true });
        }),
      ]);
      failures.push(...cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      if (!failed && failures.length) throw new AggregateError(failures, 'Owned SDK fixture cleanup failed');
    }
  }, 30_000);
});
