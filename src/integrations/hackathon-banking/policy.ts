import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BankingError } from './errors';

const identifier = z.string().min(1).max(128);
const absolutePath = z.string().refine(value => path.isAbsolute(value));
const schema = z.object({
  deploymentId: identifier,
  workspace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  executionToken: z.string().min(32),
  stateDir: absolutePath,
  frontendIssuer: identifier,
  frontendAudience: z.literal('flujo-banking-ingress'),
  frontendKeys: z.record(z.string(), z.string().min(32)),
  bankIssuer: identifier,
  bankAudience: z.literal('banking-mcp'),
  bankKeyId: identifier,
  bankSigningKeyFile: absolutePath,
  bankServerName: identifier,
  bankCommand: absolutePath,
  bankCwd: absolutePath,
  bankConfigFile: absolutePath,
  flowId: identifier,
  graphHash: z.string().regex(/^[a-f0-9]{64}$/),
  maxActiveRuns: z.number().int().min(1).max(128).default(32),
  maxQueuedRuns: z.number().int().min(0).max(1024).default(512),
  maxPendingPerSubject: z.number().int().min(1).max(16).default(3),
  maxRunSeconds: z.number().int().min(1).max(300).default(110),
  // Opt-in only after the exact installed CLI build has passed restricted
  // profile acceptance. Absence keeps authenticated native CLI runs denied.
  restrictedCodex: z.object({ verifiedCliVersion: z.string().min(1).max(128),
    verifiedCliSha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedCliPath: absolutePath.optional(),
    verifiedModelCatalogPath: absolutePath,
    verifiedModelCatalogSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

export type BankingPolicy = Readonly<z.infer<typeof schema>>;

// Private process configuration, never the graph/global-variable interpolation store.
export function getBankingPolicy(): BankingPolicy | undefined {
  const filename = process.env.FLUJO_BANKING_CONFIG;
  if (!filename) return undefined;
  try {
    if (!path.isAbsolute(filename)) throw new Error();
    const raw = readFileSync(filename, 'utf8');
    if (Buffer.byteLength(raw) > 65536) throw new Error();
    const parsed = schema.parse(JSON.parse(raw));
    if (!Object.keys(parsed.frontendKeys).length) throw new Error();
    return Object.freeze({ ...parsed, frontendKeys: Object.freeze(parsed.frontendKeys) });
  } catch {
    throw new BankingError('banking_configuration_unavailable', 503);
  }
}

export function requireBankingPolicy(): BankingPolicy {
  const policy = getBankingPolicy();
  if (!policy) throw new BankingError('banking_not_configured', 503);
  return policy;
}

export function assertBankingExecutionBearer(request: Request, policy = requireBankingPolicy()): void {
  const actual = request.headers.get('authorization') ?? '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(actual), digest(`Bearer ${policy.executionToken}`))) {
    throw new BankingError('authentication_required', 401);
  }
}

export function isBankingRoute(pathname: string): boolean {
  return pathname === '/v1/banking/session/revoke';
}

export function isProtectedBankServer(serverName: string): boolean {
  return getBankingPolicy()?.bankServerName === serverName;
}
