import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BankingPolicy } from './policy';
import { BankingError } from './errors';

export interface Identity {
  issuer: string;
  subject: string;
  session: string;
  expires: number;
  sessionExpires: number;
}

interface Owner {
  issuer: string;
  subject: string;
  graph: string;
  deployment: string;
  workspace: string;
}

export const conversationPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Single-process deployment, durable immutable owners and tombstones across restart. */
export class BankingStore {
  constructor(readonly policy: BankingPolicy) {}

  private filename(kind: string, id: string): string {
    return path.join(this.policy.stateDir, digest(this.policy.deploymentId), kind, digest(id) + '.json');
  }

  private async read(kind: string, id: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.filename(kind, id), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BankingError('banking_state_unavailable', 503);
    }
  }

  private async insert(kind: string, id: string, value: unknown): Promise<boolean> {
    const filename = this.filename(kind, id);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await fs.open(filename, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new BankingError('banking_state_unavailable', 503);
    }
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return true;
  }

  async bindSession(identity: Identity): Promise<void> {
    const expected = { issuer: identity.issuer, subject: identity.subject, expires: identity.sessionExpires };
    // Per-session lock serializes the first write/read within the single supported process.
    await this.withLock('session:' + identity.session, async () => {
      if (!await this.insert('sessions', identity.session, expected)) {
        const old = await this.read('sessions', identity.session);
        if (JSON.stringify(old) !== JSON.stringify(expected)) throw new BankingError('authorization_denied');
      }
    });
  }

  async admitSession(identity: Identity): Promise<void> {
    await this.bindSession(identity);
    await this.assertSession(identity);
  }

  async assertSession(identity: Identity): Promise<void> {
    if (identity.expires <= Date.now() / 1000 || identity.sessionExpires <= Date.now() / 1000
      || await this.read('revoked', identity.session)) throw new BankingError('authorization_expired', 401);
    const old = await this.read('sessions', identity.session) as { issuer?: string; subject?: string; expires?: number } | undefined;
    if (!old || old.issuer !== identity.issuer || old.subject !== identity.subject || old.expires !== identity.sessionExpires) {
      throw new BankingError('authorization_denied');
    }
  }

  async consumeAssertion(issuer: string, jti: string, expires: number): Promise<void> {
    await this.cleanExpiredReplays();
    if (!await this.insert('replays', issuer + '\0' + jti, { expires })) throw new BankingError('assertion_replayed', 401);
  }

  private async cleanExpiredReplays(): Promise<void> {
    const root = globalThis as typeof globalThis & { __flujoBankingReplaySweep?: Map<string, number> };
    const sweeps = root.__flujoBankingReplaySweep ??= new Map();
    const directory = path.dirname(this.filename('replays', ''));
    const now = Date.now();
    if (now - (sweeps.get(directory) ?? 0) < 60000) return;
    sweeps.set(directory, now);
    try {
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if ((await fs.stat(file)).mtimeMs > now - 125000) continue;
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as { expires: number };
        if (Number.isInteger(value.expires) && value.expires * 1000 < now - 5000) await fs.unlink(file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BankingError('banking_state_unavailable', 503);
    }
  }

  async isOwned(id: string): Promise<boolean> {
    return Boolean(await this.read('owners', id));
  }

  async revoke(identity: Identity): Promise<void> {
    await this.withLock('session:' + identity.session, async () => {
      const old = await this.read('sessions', identity.session) as { issuer?: string; subject?: string } | undefined;
      if (!old || old.issuer !== identity.issuer || old.subject !== identity.subject) throw new BankingError('authorization_denied');
      await this.insert('revoked', identity.session, { revoked: true });
    });
  }

  private owner(identity: Identity): Owner {
    return { issuer: identity.issuer, subject: identity.subject, graph: this.policy.graphHash,
      deployment: this.policy.deploymentId, workspace: this.policy.workspace };
  }

  async createConversation(id: string, identity: Identity): Promise<void> {
    if (!conversationPattern.test(id)) throw new BankingError('conversation_unavailable', 404);
    await this.assertSession(identity);
    if (await this.read('deleted', id) || !await this.insert('owners', id, this.owner(identity))) {
      throw new BankingError('conversation_unavailable', 404);
    }
  }

  async assertOwner(id: string, identity: Identity): Promise<void> {
    await this.assertSession(identity);
    if (!conversationPattern.test(id)) throw new BankingError('conversation_unavailable', 404);
    const owner = await this.read('owners', id);
    if (await this.read('deleted', id) || JSON.stringify(owner) !== JSON.stringify(this.owner(identity))) {
      throw new BankingError('conversation_unavailable', 404);
    }
  }

  async tombstone(id: string, identity: Identity): Promise<void> {
    await this.assertOwner(id, identity);
    await this.insert('deleted', id, { deleted: true });
  }

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const globalStore = globalThis as typeof globalThis & { __flujoBankingLocks?: Map<string, Promise<void>> };
    const locks = globalStore.__flujoBankingLocks ??= new Map();
    const lockKey = this.policy.stateDir + '\0' + this.policy.deploymentId + '\0' + key;
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(lockKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  }
}
