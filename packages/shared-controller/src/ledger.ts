import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory, assertPrivateFile, createPrivateFile } from './private-storage.js';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { hashPassword, verifyPassword } from './password.js';
import { localRuntimePolicySchema, type RuntimeIntent, type RuntimeProblem } from './local-runtime-policy.js';
import { modelGrantRevision, type ModelGrant } from './model-grant.js';

export const opaque = (): string => randomBytes(32).toString('base64url');
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface Session { hash: string; actorId: string; runtimeId: string; revision: string; expiresAt: number; }

/** Local account authority and explicitly submitted team data. No runtime or
 * keyring imports, private resource discovery, or execution of shared content. */
export class Ledger {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    assertPrivateDirectory(directory);
    const filename = join(directory, 'controller.sqlite');
    if (!existsSync(filename)) closeSync(createPrivateFile(filename));
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(filename + suffix)) assertPrivateFile(filename + suffix);
    }
    this.db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      // The unreleased OIDC prototype's identities must never silently become local
      // accounts. Keep that ledger intact; deliberate migration is separate work.
      if (![0, 2, 3, 4, 5, 6, 7, 8].includes(Number(version))) throw new Error('Unsupported controller ledger schema.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS actors (
          id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          auth_revision INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS runtimes (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
          origin TEXT NOT NULL UNIQUE, hostname TEXT NOT NULL UNIQUE, isolation_id TEXT NOT NULL UNIQUE,
          revision TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS sessions (
          hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
          runtime_id TEXT NOT NULL REFERENCES runtimes(id), revision TEXT NOT NULL,
          expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS passwords (
          actor_id TEXT PRIMARY KEY REFERENCES actors(id), hash TEXT NOT NULL,
          version TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS audit (
          sequence INTEGER PRIMARY KEY, time INTEGER NOT NULL,
          action TEXT NOT NULL, actor_id TEXT, runtime_id TEXT
        );
        CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS runtime_lifecycle (
          runtime_id TEXT PRIMARY KEY REFERENCES runtimes(id), policy TEXT NOT NULL, credential_digest TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1,
          desired TEXT NOT NULL CHECK(desired IN ('running','stopped')),
          phase TEXT NOT NULL CHECK(phase IN ('pending','confirmed','failed')),
          verified_at INTEGER, problem TEXT
        );
        CREATE TABLE IF NOT EXISTS runtime_provisioning (
          runtime_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
          plan TEXT NOT NULL, phase TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_rotations (
          id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES runtimes(id), plan TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('prepared','stopped','authority-updated','config-published','complete')),
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_rotation ON runtime_rotations(runtime_id) WHERE phase!='complete';
        CREATE TABLE IF NOT EXISTS runtime_model_grants (
          runtime_id TEXT NOT NULL REFERENCES runtimes(id), id TEXT NOT NULL, revision TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          configured INTEGER NOT NULL DEFAULT 1 CHECK(configured IN (0,1)),
          PRIMARY KEY(runtime_id,id)
        );
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES actors(id),
          generation INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_members (
          team_id TEXT NOT NULL REFERENCES teams(id), actor_id TEXT NOT NULL REFERENCES actors(id),
          state TEXT NOT NULL CHECK(state IN ('invited','member','removed')),
          generation INTEGER NOT NULL DEFAULT 1, invitation TEXT, expires_at INTEGER,
          PRIMARY KEY(team_id,actor_id)
        );
        CREATE INDEX IF NOT EXISTS team_members_actor ON team_members(actor_id,state);
        CREATE TABLE IF NOT EXISTS team_events (
          sequence INTEGER PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), time INTEGER NOT NULL,
          actor_id TEXT NOT NULL REFERENCES actors(id), action TEXT NOT NULL, subject_id TEXT REFERENCES actors(id)
        );
        CREATE INDEX IF NOT EXISTS team_events_team ON team_events(team_id,sequence);
        CREATE TABLE IF NOT EXISTS team_resources (
          id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), kind TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'json',
          name TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES actors(id), version INTEGER NOT NULL,
          fence INTEGER NOT NULL DEFAULT 0, lease_hash TEXT, lease_session TEXT, lease_actor TEXT,
          lease_member_generation INTEGER, lease_expires_at INTEGER, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_resources_team ON team_resources(team_id);
        CREATE TABLE IF NOT EXISTS team_resource_versions (
          resource_id TEXT NOT NULL REFERENCES team_resources(id), version INTEGER NOT NULL,
          actor_id TEXT NOT NULL REFERENCES actors(id), time INTEGER NOT NULL, name TEXT NOT NULL,
          content TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
          restored_from INTEGER, PRIMARY KEY(resource_id,version)
        );
      `);
      if (!this.db.prepare('PRAGMA table_info(team_resources)').all().some(column => column.name === 'format')) {
        this.db.exec("ALTER TABLE team_resources ADD COLUMN format TEXT NOT NULL DEFAULT 'json'");
      }
      this.db.exec('PRAGMA user_version=8; COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } finally { this.db.close(); }
      throw error;
    }
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
    if (config.runtimes.some(runtime => runtime.isolationId.startsWith('unprovisioned:'))) {
      throw new Error('Provision every new local runtime before initializing or serving accounts.');
    }
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM runtime_rotations WHERE phase!='complete' LIMIT 1").get()) {
        throw new Error('Resume pending credential rotations before initializing or serving accounts.');
      }
      // Absence is revocation. Reintroducing a runtime does not revive its sessions.
      const configured = new Set(config.runtimes.map(runtime => runtime.id));
      for (const row of this.db.prepare('SELECT id,actor_id FROM runtimes WHERE enabled=1').all()) {
        if (!configured.has(String(row.id))) {
          this.db.prepare('DELETE FROM sessions WHERE runtime_id=?').run(row.id);
          this.db.prepare('UPDATE actors SET auth_revision=auth_revision+1 WHERE id=?').run(row.actor_id);
          this.db.prepare(`UPDATE runtime_lifecycle SET desired='stopped',generation=generation+1,
            phase='pending',verified_at=NULL,problem=NULL WHERE runtime_id=?`).run(row.id);
          this.audit('runtime.removed', String(row.actor_id), String(row.id));
        }
      }
      this.db.exec('UPDATE runtimes SET enabled=0');
      // A restart/config reconciliation ends editor leases, but advances their
      // fences so pre-restart tabs cannot publish after a new editor starts.
      this.db.exec(`UPDATE team_resources SET fence=fence+1,lease_hash=NULL,lease_session=NULL,
        lease_actor=NULL,lease_member_generation=NULL,lease_expires_at=NULL WHERE lease_hash IS NOT NULL`);
      this.db.exec('UPDATE runtime_model_grants SET configured=0');
      for (const runtime of config.runtimes) {
        this.db.prepare('INSERT OR IGNORE INTO actors(id) VALUES(?)').run(runtime.actorId);
        const previous = this.db.prepare('SELECT actor_id,origin,isolation_id,revision FROM runtimes WHERE id=?').get(runtime.id);
        if (previous && (previous.actor_id !== runtime.actorId || previous.origin !== runtime.origin
            || previous.isolation_id !== runtime.isolationId)) {
          throw new Error('A runtime cannot change owner, browser origin or isolation identity.');
        }
        const revision = runtimeRevision(config, runtime);
        if (previous && previous.revision !== revision) {
          this.db.prepare('DELETE FROM sessions WHERE runtime_id=?').run(runtime.id);
          this.db.prepare('UPDATE actors SET auth_revision=auth_revision+1 WHERE id=?').run(runtime.actorId);
        }
        this.db.prepare(`INSERT INTO runtimes(id,actor_id,origin,hostname,isolation_id,revision) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=1`)
          .run(runtime.id, runtime.actorId, runtime.origin, new URL(runtime.origin).hostname, runtime.isolationId, revision);
        if (!previous || previous.revision !== revision) this.audit('runtime.configured', runtime.actorId, runtime.id);
        for (const grant of runtime.modelGrants ?? []) {
          this.db.prepare(`INSERT INTO runtime_model_grants(runtime_id,id,revision) VALUES(?,?,?)
            ON CONFLICT(runtime_id,id) DO UPDATE SET generation=generation+(revision!=excluded.revision),revision=excluded.revision,configured=1`)
            .run(runtime.id, grant.id, modelGrantRevision(grant));
        }
        const prior = this.db.prepare('SELECT policy,credential_digest FROM runtime_lifecycle WHERE runtime_id=?').get(runtime.id);
        if (prior && (JSON.stringify(runtime.localRuntime) !== prior.policy || digest(runtime.credential) !== prior.credential_digest)) {
          throw new Error('A managed runtime cannot change its local execution boundary in place.');
        }
        if (runtime.localRuntime) {
          const enabled = this.db.prepare('SELECT enabled FROM actors WHERE id=?').get(runtime.actorId)?.enabled === 1;
          this.db.prepare(`INSERT INTO runtime_lifecycle(runtime_id,policy,credential_digest,desired,phase) VALUES(?,?,?,?,'pending')
            ON CONFLICT(runtime_id) DO UPDATE SET generation=generation+1,desired=excluded.desired,
            phase='pending',verified_at=NULL,problem=NULL`)
            .run(runtime.id, JSON.stringify(runtime.localRuntime), digest(runtime.credential), enabled ? 'running' : 'stopped');
        }
      }
      this.prune();
    });
  }

  available(runtime: Runtime, revision: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM runtimes r JOIN actors a ON a.id=r.actor_id
      LEFT JOIN runtime_lifecycle l ON l.runtime_id=r.id
      WHERE r.id=? AND r.revision=? AND r.enabled=1 AND a.enabled=1
      AND NOT EXISTS(SELECT 1 FROM runtime_rotations rotation WHERE rotation.runtime_id=r.id AND rotation.phase!='complete')
      AND (l.runtime_id IS NULL OR (l.desired='running' AND l.phase='confirmed' AND l.verified_at>?
        AND json_extract(l.policy,'$.credentialExpiresAt')>?))`)
      .get(runtime.id, revision, Date.now() - 30_000, Date.now()));
  }

  /** Local operator enrollment/recovery. No email, provider, automatic enable or
   * inherited session. Check the exact configuration again after expensive work. */
  async setPassword(runtime: Runtime, revision: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.transaction(() => {
      const row = this.db.prepare('SELECT actor_id,revision,enabled FROM runtimes WHERE id=?').get(runtime.id);
      if (row?.actor_id !== runtime.actorId || row.revision !== revision || row.enabled !== 1) {
        throw new Error('Runtime configuration changed.');
      }
      this.db.prepare(`INSERT INTO passwords(actor_id,hash,version) VALUES(?,?,?)
        ON CONFLICT(actor_id) DO UPDATE SET hash=excluded.hash,version=excluded.version,attempts=0,next_attempt_at=0`)
        .run(runtime.actorId, hash, opaque());
      this.db.prepare('UPDATE actors SET auth_revision=auth_revision+1 WHERE id=?').run(runtime.actorId);
      this.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(runtime.actorId);
      this.audit('password.changed', runtime.actorId, runtime.id);
    });
  }

  async authenticate(runtime: Runtime, revision: string, password: string, seconds: number): Promise<string | null> {
    const attempt = this.transaction(() => {
      if (!this.available(runtime, revision)) return null;
      const row = this.db.prepare(`SELECT p.*,a.auth_revision FROM passwords p JOIN actors a ON a.id=p.actor_id
        WHERE p.actor_id=?`).get(runtime.actorId);
      if (!row || Number(row.next_attempt_at) > Date.now()) return null;
      // Reserve before awaiting the KDF. Persistent backoff survives restarts and
      // applies to concurrent connections, without retaining any submitted secret.
      const count = Math.min(10, Number(row.attempts) + 1);
      this.db.prepare('UPDATE passwords SET attempts=?,next_attempt_at=? WHERE actor_id=?')
        .run(count, Date.now() + Math.min(300_000, 1000 * 2 ** (count - 1)), runtime.actorId);
      return { hash: String(row.hash), version: String(row.version), authRevision: Number(row.auth_revision) };
    });
    if (!attempt || !await verifyPassword(password, attempt.hash)) return null;
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT p.version,a.auth_revision FROM passwords p JOIN actors a ON a.id=p.actor_id
        WHERE p.actor_id=?`).get(runtime.actorId);
      if (!current || current.version !== attempt.version || current.auth_revision !== attempt.authRevision
          || !this.available(runtime, revision)) return null;
      this.db.prepare('UPDATE passwords SET attempts=0,next_attempt_at=0 WHERE actor_id=?').run(runtime.actorId);
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
    if (!this.available(runtime, revision)) return null;
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

  /** Revalidate a controller-authored witness without retaining its bearer token. */
  sessionCurrent(session: Session): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sessions s JOIN runtimes r ON r.id=s.runtime_id
      JOIN actors a ON a.id=s.actor_id LEFT JOIN runtime_lifecycle l ON l.runtime_id=r.id
      WHERE s.hash=? AND s.actor_id=? AND s.runtime_id=? AND s.revision=? AND s.expires_at=?
      AND s.expires_at>? AND r.revision=s.revision AND r.actor_id=s.actor_id AND r.enabled=1 AND a.enabled=1
      AND NOT EXISTS(SELECT 1 FROM runtime_rotations rotation WHERE rotation.runtime_id=r.id AND rotation.phase!='complete')
      AND (l.runtime_id IS NULL OR (l.desired='running' AND l.phase='confirmed' AND l.verified_at>?
        AND json_extract(l.policy,'$.credentialExpiresAt')>?))`)
      .get(session.hash, session.actorId, session.runtimeId, session.revision, session.expiresAt,
        Date.now(), Date.now() - 30_000, Date.now()));
  }

  sessionHashCurrent(hash: string): boolean {
    const row = this.db.prepare(`SELECT hash,actor_id AS actorId,runtime_id AS runtimeId,
      revision,expires_at AS expiresAt FROM sessions WHERE hash=?`).get(hash);
    return !!row && this.sessionCurrent(row as unknown as Session);
  }

  setActorEnabled(actorId: string, enabled: boolean): void {
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM actors WHERE id=?').get(actorId)) throw new Error('Unknown actor.');
      if (enabled && this.db.prepare(`SELECT 1 FROM runtime_rotations rotation JOIN runtimes r ON r.id=rotation.runtime_id
          WHERE r.actor_id=? AND rotation.phase!='complete'`).get(actorId)) {
        throw new Error('Finish pending credential rotation before enabling this account.');
      }
      if (enabled && !this.db.prepare('SELECT id FROM runtimes WHERE actor_id=? AND enabled=1').get(actorId)) {
        throw new Error('A removed runtime cannot be enabled.');
      }
      this.db.prepare('UPDATE actors SET enabled=?,auth_revision=auth_revision+1 WHERE id=?').run(enabled ? 1 : 0, actorId);
      this.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(actorId);
      this.db.prepare(`UPDATE runtime_lifecycle SET desired=?,generation=generation+1,phase='pending',
        verified_at=NULL,problem=NULL WHERE runtime_id IN (SELECT id FROM runtimes WHERE actor_id=?)`)
        .run(enabled ? 'running' : 'stopped', actorId);
      this.audit(enabled ? 'actor.enabled' : 'actor.disabled', actorId, null);
    });
  }

  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  }

  modelGeneration(runtime: Runtime, revision: string, grant: ModelGrant): number | null {
    if (!this.available(runtime, revision)) return null;
    const row = this.db.prepare(`SELECT generation FROM runtime_model_grants
      WHERE runtime_id=? AND id=? AND revision=? AND enabled=1 AND configured=1`)
      .get(runtime.id, grant.id, modelGrantRevision(grant));
    return row ? Number(row.generation) : null;
  }

  setModelEnabled(actorId: string, grantId: string, enabled: boolean): void {
    this.transaction(() => {
      const runtime = this.db.prepare(`SELECT r.id FROM runtimes r JOIN runtime_model_grants g ON g.runtime_id=r.id
        WHERE r.actor_id=? AND r.enabled=1 AND g.id=? AND g.configured=1`).get(actorId, grantId);
      if (!runtime) throw new Error('Unknown configured model grant.');
      this.db.prepare('UPDATE runtime_model_grants SET enabled=?,generation=generation+1 WHERE runtime_id=? AND id=?').run(enabled ? 1 : 0, runtime.id, grantId);
      this.audit(`model.${enabled ? 'enabled' : 'disabled'}.${grantId}`, actorId, String(runtime.id));
    });
  }

  intents(): RuntimeIntent[] {
    return this.db.prepare(`SELECT l.*,r.actor_id,r.origin FROM runtime_lifecycle l
      JOIN runtimes r ON r.id=l.runtime_id ORDER BY l.desired DESC,r.id`).all().map(row => ({
      runtimeId: String(row.runtime_id), actorId: String(row.actor_id), origin: String(row.origin),
      generation: Number(row.generation), desired: row.desired as RuntimeIntent['desired'],
      phase: row.phase as RuntimeIntent['phase'], verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
      problem: row.problem as RuntimeProblem | null, policy: localRuntimePolicySchema.parse(JSON.parse(String(row.policy))),
      credentialDigest: String(row.credential_digest),
    }));
  }

  intentCurrent(intent: RuntimeIntent): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM runtime_lifecycle WHERE runtime_id=? AND generation=? AND desired=?')
      .get(intent.runtimeId, intent.generation, intent.desired));
  }

  observeRuntime(intent: RuntimeIntent): boolean {
    return this.transaction(() => {
      if (!this.intentCurrent(intent)) return false;
      const previous = this.db.prepare('SELECT phase FROM runtime_lifecycle WHERE runtime_id=?').get(intent.runtimeId);
      this.db.prepare(`UPDATE runtime_lifecycle SET phase='confirmed',verified_at=?,problem=NULL WHERE runtime_id=?`)
        .run(Date.now(), intent.runtimeId);
      if (previous?.phase !== 'confirmed') this.audit(`runtime.${intent.desired}.confirmed`, intent.actorId, intent.runtimeId);
      return true;
    });
  }

  failRuntime(intent: RuntimeIntent, problem: RuntimeProblem): void {
    this.transaction(() => {
      if (!this.intentCurrent(intent)) return;
      const previous = this.db.prepare('SELECT phase,problem FROM runtime_lifecycle WHERE runtime_id=?').get(intent.runtimeId);
      this.db.prepare(`UPDATE runtime_lifecycle SET phase='failed',verified_at=NULL,problem=? WHERE runtime_id=?`)
        .run(problem, intent.runtimeId);
      if (previous?.phase !== 'failed' || previous.problem !== problem) this.audit(`runtime.${problem}`, intent.actorId, intent.runtimeId);
    });
  }

  close(): void { this.db.close(); }
}
