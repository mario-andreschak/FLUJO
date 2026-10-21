import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory, assertPrivateFile } from './private-storage.js';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';

export const opaque = (): string => randomBytes(32).toString('base64url');
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface LoginAttempt { verifier: string; nonce: string; state: string; }
export interface Session { hash: string; actorId: string; runtimeId: string; revision: string; expiresAt: number; }

/** Controller metadata only. No runtime module, keyring, provider token or transcript. */
export class Ledger {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    assertPrivateDirectory(directory);
    const filename = join(directory, 'controller.sqlite');
    if (!existsSync(filename)) closeSync(openSync(filename, 'wx', 0o600));
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(filename + suffix)) assertPrivateFile(filename + suffix);
    }
    this.db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported controller ledger schema.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), UNIQUE(issuer,subject)
      );
      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
        origin TEXT NOT NULL UNIQUE, isolation_id TEXT NOT NULL UNIQUE,
        revision TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
        runtime_id TEXT NOT NULL REFERENCES runtimes(id), revision TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logins (
        hash TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES runtimes(id),
        revision TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        sequence INTEGER PRIMARY KEY, time INTEGER NOT NULL,
        action TEXT NOT NULL, actor_id TEXT, runtime_id TEXT
      );
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS login_expiry ON logins(expires_at);
      PRAGMA user_version=1;
    `);
  }

  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  audit(action: string, actorId: string | null, runtimeId: string | null): void {
    this.db.prepare('INSERT INTO audit(time,action,actor_id,runtime_id) VALUES(?,?,?,?)')
      .run(Date.now(), action, actorId, runtimeId);
  }

  reconcile(config: ControllerConfig): void {
    this.transaction(() => {
      // Absence is revocation. Reintroducing a runtime does not revive its sessions.
      const configured = new Set(config.runtimes.map(runtime => runtime.id));
      for (const row of this.db.prepare('SELECT id,actor_id FROM runtimes WHERE enabled=1').all()) {
        if (!configured.has(String(row.id))) {
          this.db.prepare('DELETE FROM sessions WHERE runtime_id=?').run(row.id);
          this.db.prepare('DELETE FROM logins WHERE runtime_id=?').run(row.id);
          this.audit('runtime.removed', String(row.actor_id), String(row.id));
        }
      }
      this.db.exec('UPDATE runtimes SET enabled=0');
      for (const runtime of config.runtimes) {
        const actor = this.db.prepare('SELECT issuer,subject FROM actors WHERE id=?').get(runtime.actorId);
        if (actor && (actor.issuer !== config.issuer || actor.subject !== runtime.subject)) {
          throw new Error('An actor cannot be rebound to another identity.');
        }
        this.db.prepare('INSERT OR IGNORE INTO actors(id,issuer,subject) VALUES(?,?,?)')
          .run(runtime.actorId, config.issuer, runtime.subject);
        const previous = this.db.prepare('SELECT actor_id,origin,isolation_id,revision FROM runtimes WHERE id=?').get(runtime.id);
        if (previous && (previous.actor_id !== runtime.actorId || previous.origin !== runtime.origin
            || previous.isolation_id !== runtime.isolationId)) {
          throw new Error('A runtime cannot change owner, browser origin or isolation identity.');
        }
        const revision = runtimeRevision(config, runtime);
        if (previous && previous.revision !== revision) {
          this.db.prepare('DELETE FROM sessions WHERE runtime_id=?').run(runtime.id);
          this.db.prepare('DELETE FROM logins WHERE runtime_id=?').run(runtime.id);
        }
        this.db.prepare(`INSERT INTO runtimes(id,actor_id,origin,isolation_id,revision) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=1`)
          .run(runtime.id, runtime.actorId, runtime.origin, runtime.isolationId, revision);
        if (!previous || previous.revision !== revision) this.audit('runtime.configured', runtime.actorId, runtime.id);
      }
      this.prune();
    });
  }

  available(runtime: Runtime, revision: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM runtimes r JOIN actors a ON a.id=r.actor_id
      WHERE r.id=? AND r.revision=? AND r.enabled=1 AND a.enabled=1`).get(runtime.id, revision));
  }

  beginLogin(runtime: Runtime, revision: string, attempt: LoginAttempt): string {
    return this.transaction(() => {
      this.prune();
      if (!this.available(runtime, revision)) throw new Error('Runtime unavailable.');
      const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM logins').get()?.count);
      if (count >= 10000) throw new Error('Too many pending sign-ins.');
      const token = opaque();
      this.db.prepare('INSERT INTO logins VALUES(?,?,?,?,?,?,?)')
        .run(digest(token), runtime.id, revision, attempt.verifier, attempt.nonce, attempt.state, Date.now() + 600_000);
      return token;
    });
  }

  consumeLogin(token: string, runtime: Runtime, revision: string): LoginAttempt | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM logins WHERE hash=?').get(digest(token));
      this.db.prepare('DELETE FROM logins WHERE hash=?').run(digest(token));
      if (!row || row.runtime_id !== runtime.id || row.revision !== revision
          || Number(row.expires_at) <= Date.now() || !this.available(runtime, revision)) return null;
      return { verifier: String(row.verifier), nonce: String(row.nonce), state: String(row.state) };
    });
  }

  createSession(runtime: Runtime, revision: string, issuer: string, subject: string, seconds: number): string | null {
    return this.transaction(() => {
      const actor = this.db.prepare('SELECT id FROM actors WHERE issuer=? AND subject=? AND enabled=1').get(issuer, subject);
      if (actor?.id !== runtime.actorId || !this.available(runtime, revision)) return null;
      this.prune();
      // Bound durable sessions per actor without evicting every existing browser on login.
      this.db.prepare(`DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE actor_id=?
        ORDER BY created_at DESC LIMIT -1 OFFSET 19)`).run(runtime.actorId);
      const token = opaque();
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
        .run(digest(token), runtime.actorId, runtime.id, revision, Date.now() + seconds * 1000, Date.now());
      this.audit('session.created', runtime.actorId, runtime.id);
      return token;
    });
  }

  session(token: string, runtime: Runtime, revision: string): Session | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare(`SELECT s.* FROM sessions s JOIN runtimes r ON r.id=s.runtime_id
      JOIN actors a ON a.id=s.actor_id WHERE s.hash=? AND s.runtime_id=? AND s.revision=?
      AND r.revision=s.revision AND r.enabled=1 AND a.enabled=1 AND s.expires_at>?`)
      .get(digest(token), runtime.id, revision, Date.now());
    return row ? { hash: String(row.hash), actorId: String(row.actor_id), runtimeId: String(row.runtime_id),
      revision: String(row.revision), expiresAt: Number(row.expires_at) } : null;
  }

  revokeSession(token: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT actor_id,runtime_id FROM sessions WHERE hash=?').get(digest(token));
      this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));
      if (row) this.audit('session.revoked', String(row.actor_id), String(row.runtime_id));
    });
  }

  setActorEnabled(actorId: string, enabled: boolean): void {
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM actors WHERE id=?').get(actorId)) throw new Error('Unknown actor.');
      this.db.prepare('UPDATE actors SET enabled=? WHERE id=?').run(enabled ? 1 : 0, actorId);
      this.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(actorId);
      this.db.prepare('DELETE FROM logins WHERE runtime_id IN (SELECT id FROM runtimes WHERE actor_id=?)').run(actorId);
      this.audit(enabled ? 'actor.enabled' : 'actor.disabled', actorId, null);
    });
  }

  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('DELETE FROM logins WHERE expires_at<=?').run(Date.now());
  }

  close(): void { this.db.close(); }
}
