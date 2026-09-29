import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import type { Flow } from '@/shared/types/flow';
import { hashFlowExecutionSnapshot } from '@/backend/services/flow/executionSnapshot';

/** In-memory graph and temporary synthetic authority state; no saved/customer flow. */
export async function bankingFixture(maxActiveRuns = 4) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-acceptance-'));
  const previousConfig = process.env.FLUJO_BANKING_CONFIG;
  const front = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const bank = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  await fs.writeFile(path.join(directory, 'bank.pem'), await exportPKCS8(bank.privateKey));
  const graph: Flow = { id: randomUUID(), name: 'Acceptance Process', nodes: ['start', 'process', 'finish'].map((kind, index) => ({
    id: kind, type: kind, position: { x: index * 200, y: 0 }, data: { type: kind, label: kind,
      properties: kind === 'process' ? { boundModel: 'deterministic-model', promptTemplate: 'Answer this inquiry.' } : {} },
  })), edges: [{ id: 'start-process', source: 'start', target: 'process' },
    { id: 'process-finish', source: 'process', target: 'finish' }] };
  const policy = { deploymentId: randomUUID(), workspace: 'default-workspace', executionToken: 'fixture'.repeat(8),
    stateDir: path.join(directory, 'state'), frontendIssuer: 'acceptance-frontend', frontendAudience: 'flujo-banking-ingress',
    frontendKeys: { front: await exportSPKI(front.publicKey) }, bankIssuer: 'acceptance-runtime', bankAudience: 'banking-mcp',
    bankKeyId: 'bank', bankSigningKeyFile: path.join(directory, 'bank.pem'), bankServerName: 'Banking MCP',
    bankCommand: path.join(directory, 'python'), bankCwd: directory, bankConfigFile: path.join(directory, 'bank.json'),
    flowId: graph.id, graphHash: hashFlowExecutionSnapshot(graph), maxActiveRuns, maxQueuedRuns: 512,
    maxPendingPerSubject: 3, maxRunSeconds: 110 };
  const configFile = path.join(directory, 'policy.json');
  await fs.writeFile(configFile, JSON.stringify(policy));
  process.env.FLUJO_BANKING_CONFIG = configFile;
  const sessions = new Map<string, { id: string; expires: number }>();
  async function request(subject: string, body?: unknown, pathname = '/v1/chat/completions', method = 'POST',
    overrides: Record<string, unknown> = {}): Promise<NextRequest> {
    const now = Math.floor(Date.now() / 1000);
    if (!sessions.has(subject)) sessions.set(subject, { id: randomUUID(), expires: now + 3600 });
    const session = sessions.get(subject)!;
    const assertion = await new SignJWT({ sub: subject, session_id: session.id, session_exp: session.expires,
      iat: now, nbf: now, exp: now + 120, jti: randomUUID(), scope: ['bank:read'], ...overrides })
      .setIssuer(policy.frontendIssuer).setAudience(policy.frontendAudience)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'front', typ: 'flujo-ingress+jwt' }).sign(front.privateKey);
    return new NextRequest('http://localhost' + pathname, { method,
      headers: { Authorization: 'Bearer ' + policy.executionToken, 'X-Flujo-User-Assertion': assertion,
        'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  function completion(content = 'safe inquiry', extra: Record<string, unknown> = {}) {
    return { model: 'flow-' + graph.name, messages: [{ role: 'user', content }], ...extra };
  }
  async function close() {
    if (previousConfig === undefined) delete process.env.FLUJO_BANKING_CONFIG;
    else process.env.FLUJO_BANKING_CONFIG = previousConfig;
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('execution-acceptance-')) {
      throw new Error('Unsafe fixture cleanup path');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  return { directory, configFile, policy, graph, front, bank, sessions, request, completion, close };
}
