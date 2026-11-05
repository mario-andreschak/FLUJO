import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueNamedCredential, type OwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { ACCESS_ROLE_SCOPES, type AccessRole, type OwnerScope } from '@/shared/types/access';

const DAY = 24 * 60 * 60 * 1000;

export interface NamedAccessFixture {
  directory: string;
  policyFile: string;
  tokens: Record<string, string>;
  ids: Record<string, string>;
  /** Rewrite the policy the way an operator would, atomically. */
  write(policy: OwnerPolicy): void;
  read(): OwnerPolicy;
  add(name: string, input: { role?: AccessRole; scopes?: OwnerScope[]; workspaceId?: string; flowIds?: string[]; expiresAt?: number }): string;
  restore(): void;
}

/** A real schema 2 policy on disk, selected the same way an installation selects it. */
export function createNamedAccessFixture(people: Record<string, AccessRole | { role?: AccessRole; scopes?: OwnerScope[]; workspaceId?: string; flowIds?: string[] }>): NamedAccessFixture {
  const saved = Object.fromEntries(['FLUJO_OWNER_AUTH_FILE', 'FLUJO_OWNER_BROWSER_ORIGIN', 'FLUJO_WORKER_MODE', 'FLUJO_ACCESS_AUDIT_MAX_BYTES', 'FLUJO_EXPOSURE_MODE']
    .map(key => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-named-access-'));
  const policyFile = path.join(directory, 'owner.json');
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const credentials: OwnerCredential[] = [];
  const now = Date.now();
  const issue = (name: string, input: { role?: AccessRole; scopes?: OwnerScope[]; workspaceId?: string; flowIds?: string[]; expiresAt?: number }) => {
    const issued = issueNamedCredential({
      name, scopes: input.scopes ?? ACCESS_ROLE_SCOPES[input.role!], role: input.role ?? 'custom',
      expiresAt: input.expiresAt ?? now + DAY,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.flowIds ? { flowIds: input.flowIds } : {}),
    }, now - 1000);
    tokens[name] = issued.token;
    ids[name] = issued.record.id;
    return issued.record;
  };
  for (const [name, value] of Object.entries(people)) {
    credentials.push(issue(name, typeof value === 'string' ? { role: value } : value));
  }
  const write = (policy: OwnerPolicy) => {
    const staged = `${policyFile}.new`;
    fs.writeFileSync(staged, JSON.stringify(policy), { mode: 0o600 });
    fs.renameSync(staged, policyFile);
  };
  write({ schemaVersion: 2, ownerId: 'owner', credentials });
  process.env.FLUJO_OWNER_AUTH_FILE = policyFile;
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  delete process.env.FLUJO_WORKER_MODE;
  const read = () => JSON.parse(fs.readFileSync(policyFile, 'utf8')) as OwnerPolicy;
  return {
    directory, policyFile, tokens, ids, write, read,
    add(name, input) {
      const record = issue(name, input);
      const policy = read();
      write({ ...policy, credentials: [...policy.credentials, record] });
      return tokens[name];
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function bearer(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('host', new URL(url).host);
  return new Request(url, { ...init, headers });
}
