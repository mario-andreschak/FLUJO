/** Explicit local-image source probe; no registry pull or live provider. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewClient, createTransport, safelyCloseClient } from '@/backend/services/mcp/connection';
import { createNewBetaClient, createBetaTransport } from '@/backend/services/mcp/betaClient';
import { isolatedMcpPolicyDigest } from '@/backend/services/security/isolatedMcp';
import { getManagedMcpIsolation } from '@/backend/services/mcp/isolation';
import { listServerTools, callTool } from '@/backend/services/mcp/tools';
import { getCurrentWorkspace } from '@/utils/workspace';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import type { MCPStdioConfig } from '@/shared/types/mcp';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async (_key: unknown, fallback: unknown) => fallback), saveItem: jest.fn() }));
const probe = process.env.FLUJO_RUN_ISOLATION_SOURCE_PROBE === '1' ? test : test.skip;

probe.each(['v1', 'beta'])('real %s SDK uses an approved Linux container for discovery, tool dispatch and cleanup', async era => {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'flujo-mcp-source-test-'));
  const saved = { FLUJO_OWNER_AUTH_FILE: process.env.FLUJO_OWNER_AUTH_FILE, FLUJO_MCP_ISOLATION_FILE: process.env.FLUJO_MCP_ISOLATION_FILE };
  // Fits the policy's bounded command argument. Read/write checks use only
  // synthetic in-container locations; no host private paths are referenced.
  const program = `const f=require('fs'),r=require('readline').createInterface({input:process.stdin});let caps={},calls=0;
const deny=fn=>{try{fn();return false}catch{return true}};
const flags=()=>({nonRoot:process.getuid()===65534,rootWriteDenied:deny(()=>f.writeFileSync('/forbidden','x')),unrelatedEnvAbsent:process.env.UNRELATED_SECRET===undefined,grantedEnv:process.env.GRANTED_FIXTURE==='synthetic fixture',memoryBound:f.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()==='134217728',noHostOAuth:!caps.elicitation?.url,calls:++calls});
r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;
if(q.method==='initialize'){caps=q.params.capabilities;result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-fixture',version:'1'}}}
if(q.method==='ping')result={};
if(q.method==='tools/list')result=q.params?.cursor?{tools:[{name:'probe',title:'Probed boundary',inputSchema:{type:'object'},outputSchema:{type:'object'},execution:{taskSupport:'optional'}}]}:{tools:[{name:'first_page',inputSchema:{type:'object'}}],nextCursor:'page2'};
if(q.method==='tools/call'){const value=flags();result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}}
console.log(JSON.stringify(result===undefined?{jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'unsupported'}}:{jsonrpc:'2.0',id:q.id,result}))});r.on('close',()=>process.exit(0));`;
  const policy = { schemaVersion: 1, kind: 'docker-deny-egress',
    dockerExecutable: process.env.FLUJO_TEST_ISOLATION_DOCKER ?? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
    daemon: process.env.FLUJO_TEST_ISOLATION_DAEMON ?? 'npipe:////./pipe/dockerDesktopLinuxEngine',
    image: process.env.FLUJO_TEST_ISOLATION_IMAGE ?? 'sha256:fc8cd9deea7389d01d9a70cc83a5d09465c2050f2ae322d67300a9794433edad',
    command: ['node', '-e', program], environmentNames: ['GRANTED_FIXTURE'], mounts: [], memoryMiB: 128, cpus: 0.5, pidsLimit: 32 };
  const config: MCPStdioConfig = { name: `isolated-source-${era}`, transport: 'stdio', command: 'node', args: ['-e', program],
    env: { GRANTED_FIXTURE: 'synthetic fixture', UNRELATED_SECRET: 'must not forward' }, disabled: false,
    rootPath: '', _buildCommand: '', _installCommand: '', isolation: policy };
  const client = era === 'v1' ? createNewClient(config) : createNewBetaClient(config);
  let transport: ReturnType<typeof createTransport> | ReturnType<typeof createBetaTransport> | undefined;
  try {
    process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
    process.env.FLUJO_MCP_ISOLATION_FILE = path.join(directory, 'approvals.json');
    fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'fixture-owner', credentials: [] }), { mode: 0o600 });
    fs.writeFileSync(process.env.FLUJO_MCP_ISOLATION_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'fixture-owner',
      approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name, policyDigest: isolatedMcpPolicyDigest(policy), expiresAt: Date.now() + 30_000 }] }), { mode: 0o600 });
    jest.mocked(loadServerConfigs).mockResolvedValue([config]);
    transport = era === 'v1' ? createTransport(config) : createBetaTransport(config);
    await client.connect(transport);
    const listed = await listServerTools(client, config.name);
    expect(listed.error).toBeUndefined();
    expect(listed.tools.map(tool => tool.name)).toEqual(['first_page', 'probe']);
    expect(listed.tools[1]).toMatchObject({ title: 'Probed boundary', outputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } });
    const result = await callTool(client, config.name, 'probe', {}, 5);
    if (!result.success) throw new Error(JSON.stringify({ sourceProbeFailure: { error: result.error, errorType: result.errorType, statusCode: result.statusCode } }));
    expect((result.data as { structuredContent: unknown }).structuredContent).toEqual({ nonRoot: true, rootWriteDenied: true,
      unrelatedEnvAbsent: true, grantedEnv: true, memoryBound: true, noHostOAuth: true, calls: 1 });
    expect(await callTool(client, config.name, 'probe', { nested: ['${global:HOST_PRIVATE_KEY}'] }, 5))
      .toMatchObject({ success: false, error: 'ISOLATION_POLICY_INVALID', statusCode: 403 });
    const second = await callTool(client, config.name, 'probe', {}, 5);
    expect((second.data as { structuredContent: { calls: number } }).structuredContent.calls).toBe(2);
    fs.writeFileSync(process.env.FLUJO_MCP_ISOLATION_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'fixture-owner', approvals: [] }), { mode: 0o600 });
    expect(await callTool(client, config.name, 'probe', {}, 5)).toMatchObject({ success: false,
      error: 'ISOLATION_RECONSENT_REQUIRED', errorType: 'mcp-isolation', statusCode: 403 });
    const closed = await safelyCloseClient(client, config.name, config, { gracePeriodMs: 500, killEscalationMs: 500 });
    expect(closed.isolation?.cleanupOutcome).toMatch(/^(removed|absent)$/);
    console.log(JSON.stringify({ sourceContainerProbe: era, discoveryPages: 2, flags: 'passed', cleanup: closed.isolation?.cleanupOutcome }));
  } finally {
    getManagedMcpIsolation(transport)?.close();
    await client.close().catch(() => {});
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const relative = path.relative(tempRoot, directory);
    if (!/^flujo-mcp-source-test-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe source probe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
