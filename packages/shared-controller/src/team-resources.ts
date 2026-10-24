import { digest, opaque, type Ledger, type Session } from './ledger.js';
import { TeamError, Teams } from './teams.js';
import { readSharedModel, SHARED_MODEL_FORMAT } from './shared-model.js';
import { flowDependencies, readSharedFlow, SHARED_FLOW_FORMAT } from './shared-flow.js';

export const RESOURCE_KINDS = ['model', 'mcp', 'flow', 'chat', 'execution'] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export const RESOURCE_BYTES = 1024 * 1024;
export const EDIT_SECONDS = 120;
const ID = /^[A-Za-z0-9_-]{43}$/;
const TEAM_BYTES = 128 * 1024 * 1024;
const TOTAL_BYTES = 512 * 1024 * 1024;

export interface SharedResource {
  id: string; teamId: string; kind: ResourceKind; format: string; name: string; creatorId: string; version: number; createdAt: number;
}
export interface ResourceRevision {
  version: number; actorId: string; time: number; name: string; content: string; digest: string; bytes: number; restoredFrom: number | null;
}
export interface EditorLease { token: string; fence: number; expiresAt: number; version: number; }
interface StoredResource extends SharedResource {
  fence: number; leaseHash: string | null; leaseSession: string | null; leaseActor: string | null;
  leaseMemberGeneration: number | null; leaseExpiresAt: number | null;
}
const columns = `id,team_id AS teamId,kind,format,name,creator_id AS creatorId,version,created_at AS createdAt,fence,
  lease_hash AS leaseHash,lease_session AS leaseSession,lease_actor AS leaseActor,
  lease_member_generation AS leaseMemberGeneration,lease_expires_at AS leaseExpiresAt`;
const revisionColumns = 'version,actor_id AS actorId,time,name,content,digest,bytes,restored_from AS restoredFrom';
const summary = (row: StoredResource): SharedResource => ({ id: row.id, teamId: row.teamId, kind: row.kind,
  format: row.format, name: row.name, creatorId: row.creatorId, version: row.version, createdAt: row.createdAt });

/** Passive JSON documents with local transactional editing. Storing a document
 * grants neither execution nor access to its referenced private dependencies.
 * HTTP never accepts a filesystem path, provider destination or runtime bearer. */
export class TeamResources {
  private readonly teams: Teams;
  constructor(private readonly ledger: Ledger) { this.teams = new Teams(ledger); }

  private row(teamId: string, resourceId: string): StoredResource {
    if (!ID.test(resourceId)) throw new TeamError(404, 'Shared resource unavailable.');
    const row = this.ledger.db.prepare(`SELECT ${columns} FROM team_resources WHERE id=? AND team_id=?`).get(resourceId, teamId);
    if (!row) throw new TeamError(404, 'Shared resource unavailable.');
    return row as unknown as StoredResource;
  }

  private name(value: string): string {
    const name = value.trim().normalize('NFC');
    if (!name || name.length > 120 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
      throw new TeamError(400, 'Use a resource name of 1–120 characters without control characters.');
    }
    return name;
  }

  private content(text: string, kind: string, teamId: string, requiredFormat?: string): { content: string; digest: string; bytes: number; format: string } {
    if (Buffer.byteLength(text) > RESOURCE_BYTES) throw new TeamError(413, 'A shared resource is limited to 1 MiB.');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new TeamError(400, 'The resource must be valid JSON. Your saved version is unchanged.'); }
    if (!value || typeof value !== 'object') throw new TeamError(400, 'The resource must be a JSON object or array.');
    // Depth and entry bounds also protect later consumers of this data. We do
    // not merge keys into authority/configuration objects or execute strings.
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let entries = 0;
    while (pending.length) {
      const next = pending.pop()!;
      if (++entries > 50_000 || next.depth > 64) throw new TeamError(413, 'The resource structure is too large or deeply nested.');
      if (next.value && typeof next.value === 'object') {
        for (const [key, item] of Object.entries(next.value)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TeamError(400, 'The resource contains an unsupported object key.');
          pending.push({ value: item, depth: next.depth + 1 });
        }
      }
    }
    let format = requiredFormat ?? 'json';
    if (requiredFormat === SHARED_MODEL_FORMAT || (requiredFormat === undefined && (value as { format?: unknown }).format === SHARED_MODEL_FORMAT)) {
      if (kind !== 'model') throw new TeamError(400, 'A shared model document must use the model kind.');
      try { value = readSharedModel(value); } catch { throw new TeamError(400, 'Invalid shared model configuration. Credentials and private bindings cannot be shared.'); }
      format = SHARED_MODEL_FORMAT;
    } else if (requiredFormat === SHARED_FLOW_FORMAT || (requiredFormat === undefined && (value as { format?: unknown }).format === SHARED_FLOW_FORMAT)) {
      if (kind !== 'flow') throw new TeamError(400, 'A shared Flow document must use the flow kind.');
      try {
        const document = readSharedFlow(value, teamId);
        for (const dependency of flowDependencies(document)) {
          const resourceId = dependency.value.split(':')[2];
          if (!this.ledger.db.prepare('SELECT 1 FROM team_resources WHERE id=? AND team_id=? AND kind=? AND format=?')
            .get(resourceId, teamId, dependency.kind, `flujo.${dependency.kind}.v1`)) {
            throw new Error('Dependency unavailable.');
          }
        }
        value = document;
      } catch { throw new TeamError(400, 'Invalid shared Flow. Choose existing typed dependencies from this team and remove private bindings or credentials.'); }
      format = SHARED_FLOW_FORMAT;
    } else if (requiredFormat !== undefined && requiredFormat !== 'json') throw new TeamError(409, 'Unsupported resource format.');
    const content = JSON.stringify(value, null, 2);
    const bytes = Buffer.byteLength(content);
    if (bytes > RESOURCE_BYTES) throw new TeamError(413, 'The formatted resource exceeds 1 MiB.');
    return { content, digest: digest(content), bytes, format };
  }

  private capacity(teamId: string, bytes: number, resourceId?: string): void {
    const total = Number(this.ledger.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM team_resource_versions').get()?.bytes);
    const team = Number(this.ledger.db.prepare(`SELECT coalesce(sum(v.bytes),0) AS bytes FROM team_resource_versions v
      JOIN team_resources r ON r.id=v.resource_id WHERE r.team_id=?`).get(teamId)?.bytes);
    if (total + bytes > TOTAL_BYTES || team + bytes > TEAM_BYTES) {
      throw new TeamError(409, 'Shared resource storage is full. Existing revisions are preserved; contact your installation administrator.');
    }
    if (resourceId && Number(this.ledger.db.prepare('SELECT count(*) AS n FROM team_resource_versions WHERE resource_id=?').get(resourceId)?.n) >= 1000) {
      throw new TeamError(409, 'This resource has reached 1,000 revisions. Its history is preserved. Download the revisions you need before creating another shared resource.');
    }
  }

  private active(row: StoredResource): boolean {
    if (!row.leaseHash || !row.leaseSession || !row.leaseActor || !row.leaseExpiresAt
        || row.leaseExpiresAt <= Date.now() || row.leaseExpiresAt > Date.now() + EDIT_SECONDS * 1000
        || !this.ledger.sessionHashCurrent(row.leaseSession)) return false;
    return !!this.ledger.db.prepare(`SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id
      WHERE m.team_id=? AND m.actor_id=? AND m.state='member' AND m.generation=? AND t.archived=0`)
      .get(row.teamId, row.leaseActor, row.leaseMemberGeneration);
  }

  private held(row: StoredResource, session: Session, memberGeneration: number, token: string, fence: number): void {
    if (!ID.test(token) || !this.active(row) || row.leaseSession !== session.hash || row.leaseActor !== session.actorId
        || row.leaseHash !== digest(token) || row.fence !== fence || row.leaseMemberGeneration !== memberGeneration) {
      throw new TeamError(409, 'Your edit lock ended. Keep your draft, then reload and acquire a new lock before saving.');
    }
  }

  private revision(resourceId: string, version: number): ResourceRevision {
    const row = this.ledger.db.prepare(`SELECT ${revisionColumns} FROM team_resource_versions WHERE resource_id=? AND version=?`).get(resourceId, version);
    if (!row) throw new TeamError(404, 'Resource revision unavailable.');
    return row as unknown as ResourceRevision;
  }

  list(session: Session, teamId: string): SharedResource[] {
    return this.teams.withMember(session, teamId, () => this.ledger.db.prepare(`SELECT ${columns} FROM team_resources
      WHERE team_id=? ORDER BY created_at,id`).all(teamId).map(row => summary(row as unknown as StoredResource)));
  }

  read(session: Session, teamId: string, resourceId: string, version?: number): {
    resource: SharedResource; revision: ResourceRevision; editor: { actorId: string; expiresAt: number } | null;
  } {
    return this.teams.withMember(session, teamId, () => {
      const row = this.row(teamId, resourceId);
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new TeamError(404, 'Resource revision unavailable.');
      return { resource: summary(row), revision: this.revision(row.id, version ?? row.version),
        editor: this.active(row) ? { actorId: row.leaseActor!, expiresAt: row.leaseExpiresAt! } : null };
    });
  }

  history(session: Session, teamId: string, resourceId: string): Omit<ResourceRevision, 'content'>[] {
    return this.teams.withMember(session, teamId, () => {
      this.row(teamId, resourceId);
      return this.ledger.db.prepare(`SELECT version,actor_id AS actorId,time,name,digest,bytes,restored_from AS restoredFrom
        FROM team_resource_versions WHERE resource_id=? ORDER BY version DESC`).all(resourceId) as unknown as Omit<ResourceRevision, 'content'>[];
    });
  }

  create(session: Session, teamId: string, kind: string, nameInput: string, text: string): string {
    return this.teams.withMember(session, teamId, () => {
      const name = this.name(nameInput); const content = this.content(text, kind, teamId);
      if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) throw new TeamError(400, 'Unsupported resource kind.');
      if (Number(this.ledger.db.prepare('SELECT count(*) AS n FROM team_resources WHERE team_id=?').get(teamId)?.n) >= 1000) {
        throw new TeamError(409, 'This team has reached 1,000 shared resources.');
      }
      this.capacity(teamId, content.bytes);
      const id = opaque(); const now = Date.now();
      this.ledger.db.prepare('INSERT INTO team_resources(id,team_id,kind,format,name,creator_id,version,created_at) VALUES(?,?,?,?,?,?,1,?)')
        .run(id, teamId, kind, content.format, name, session.actorId, now);
      this.ledger.db.prepare('INSERT INTO team_resource_versions(resource_id,version,actor_id,time,name,content,digest,bytes) VALUES(?,1,?,?,?,?,?,?)')
        .run(id, session.actorId, now, name, content.content, content.digest, content.bytes);
      return id;
    });
  }

  acquire(session: Session, teamId: string, resourceId: string, version: number): EditorLease {
    return this.teams.withMember(session, teamId, memberGeneration => {
      const row = this.row(teamId, resourceId);
      if (row.version !== version) throw new TeamError(409, 'This resource changed. Reload its current version before editing.');
      if (this.active(row)) throw new TeamError(423, 'Another editor already holds this resource. Wait for their save, release, or lock expiry.');
      const token = opaque(); const expiresAt = Math.min(session.expiresAt, Date.now() + EDIT_SECONDS * 1000);
      this.ledger.db.prepare(`UPDATE team_resources SET fence=fence+1,lease_hash=?,lease_session=?,lease_actor=?,
        lease_member_generation=?,lease_expires_at=? WHERE id=?`).run(digest(token), session.hash, session.actorId, memberGeneration, expiresAt, row.id);
      return { token, fence: row.fence + 1, expiresAt, version: row.version };
    });
  }

  renew(session: Session, teamId: string, resourceId: string, token: string, fence: number): number {
    return this.teams.withMember(session, teamId, memberGeneration => {
      const row = this.row(teamId, resourceId); this.held(row, session, memberGeneration, token, fence);
      const expiresAt = Math.min(session.expiresAt, Date.now() + EDIT_SECONDS * 1000);
      this.ledger.db.prepare('UPDATE team_resources SET lease_expires_at=? WHERE id=?').run(expiresAt, row.id);
      return expiresAt;
    });
  }

  release(session: Session, teamId: string, resourceId: string, token: string, fence: number): void {
    this.teams.withMember(session, teamId, memberGeneration => {
      const row = this.row(teamId, resourceId); this.held(row, session, memberGeneration, token, fence);
      this.clear(row.id);
    });
  }

  private clear(id: string): void {
    this.ledger.db.prepare(`UPDATE team_resources SET lease_hash=NULL,lease_session=NULL,lease_actor=NULL,
      lease_member_generation=NULL,lease_expires_at=NULL WHERE id=?`).run(id);
  }

  save(session: Session, teamId: string, resourceId: string, token: string, fence: number, version: number,
    nameInput: string, text: string): number {
    return this.teams.withMember(session, teamId, memberGeneration => {
      const row = this.row(teamId, resourceId); this.held(row, session, memberGeneration, token, fence);
      if (row.version !== version) throw new TeamError(409, 'This resource changed. Keep your draft and reload its current version.');
      const name = this.name(nameInput); const content = this.content(text, row.kind, teamId, row.format);
      this.capacity(teamId, content.bytes, resourceId);
      const next = row.version + 1;
      this.ledger.db.prepare(`INSERT INTO team_resource_versions(resource_id,version,actor_id,time,name,content,digest,bytes)
        VALUES(?,?,?,?,?,?,?,?)`).run(row.id, next, session.actorId, Date.now(), name, content.content, content.digest, content.bytes);
      this.ledger.db.prepare('UPDATE team_resources SET name=?,version=? WHERE id=?').run(name, next, row.id);
      this.clear(row.id); return next;
    });
  }

  restore(session: Session, teamId: string, resourceId: string, version: number, restoredFrom: number): number {
    return this.teams.withMember(session, teamId, () => {
      const row = this.row(teamId, resourceId);
      if (row.version !== version) throw new TeamError(409, 'This resource changed. Reload before restoring a revision.');
      if (this.active(row)) throw new TeamError(423, 'An editor holds this resource. Release the lock before restoring a revision.');
      const prior = this.revision(row.id, restoredFrom);
      this.content(prior.content, row.kind, teamId, row.format);
      this.capacity(teamId, prior.bytes, row.id);
      const next = row.version + 1;
      this.ledger.db.prepare(`INSERT INTO team_resource_versions(resource_id,version,actor_id,time,name,content,digest,bytes,restored_from)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, next, session.actorId, Date.now(), prior.name, prior.content, prior.digest, prior.bytes, restoredFrom);
      this.ledger.db.prepare('UPDATE team_resources SET name=?,version=?,fence=fence+1 WHERE id=?').run(prior.name, next, row.id);
      this.clear(row.id); return next;
    });
  }
}
