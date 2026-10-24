import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { digest, type Ledger, type Session } from './ledger.js';
import type { ModelGrant } from './model-grant.js';
import { readSharedModel, SHARED_MODEL_FORMAT, type SharedModelDocument } from './shared-model.js';
import { Teams, TeamError } from './teams.js';
import { teamModelSummarySchema, type TeamModelReference } from './team-model-protocol.js';

const ID = /^[A-Za-z0-9_-]{43}$/;
interface Binding {
  resource_id: string; generation: number; enabled: number; version: number;
  runtime_id: string; runtime_revision: string; grant_id: string; grant_generation: number;
  member_generation: number; auth_revision: number;
}
interface Resource { id: string; teamId: string; teamName: string; version: number; content: string; }
export interface TeamModelAdmission {
  teamId: string; resourceId: string; teamName: string; version: number; generation: string;
  document: SharedModelDocument; grant: ModelGrant;
}
export interface TeamModelAccessState {
  generation: number; enabled: boolean; grantedBy: string | null; version: number;
  options: { id: string; model: string }[];
  history: { actorId: string; time: number; action: string; version: number; generation: number }[];
}

/** Only already configured host-local services can be delegated. A shared
 * document, runtime-supplied endpoint or another member's grant is not authority. */
export class TeamModelAccess {
  private readonly teams: Teams;
  constructor(private readonly config: ControllerConfig, private readonly ledger: Ledger) { this.teams = new Teams(ledger); }

  private resource(teamId: string, id: string): Resource {
    if (!ID.test(teamId) || !ID.test(id)) throw new TeamError(404, 'Team model unavailable.');
    const row = this.ledger.db.prepare(`SELECT r.id,r.team_id AS teamId,t.name AS teamName,r.version,v.content
      FROM team_resources r JOIN teams t ON t.id=r.team_id
      JOIN team_resource_versions v ON v.resource_id=r.id AND v.version=r.version
      WHERE r.id=? AND r.team_id=? AND r.kind='model' AND r.format=? AND t.archived=0`).get(id, teamId, SHARED_MODEL_FORMAT);
    if (!row) throw new TeamError(404, 'Team model unavailable.');
    return row as unknown as Resource;
  }

  private member(actorId: string, teamId: string): { member: number; auth: number } {
    const row = this.ledger.db.prepare(`SELECT m.generation,a.auth_revision FROM team_members m
      JOIN actors a ON a.id=m.actor_id JOIN teams t ON t.id=m.team_id
      WHERE m.team_id=? AND m.actor_id=? AND m.state='member' AND a.enabled=1 AND t.archived=0`).get(teamId, actorId);
    if (!row) throw new TeamError(403, 'Team model access ended.');
    return { member: Number(row.generation), auth: Number(row.auth_revision) };
  }

  private binding(id: string): Binding | undefined {
    return this.ledger.db.prepare('SELECT * FROM team_model_access WHERE resource_id=?').get(id) as unknown as Binding | undefined;
  }

  private runtime(id: string): Runtime {
    const runtime = this.config.runtimes.find(value => value.id === id);
    if (!runtime?.localRuntime || !this.ledger.available(runtime, runtimeRevision(this.config, runtime))) {
      throw new TeamError(403, 'Local model runtime unavailable.');
    }
    return runtime;
  }

  private document(resource: Resource): SharedModelDocument {
    const document = readSharedModel(JSON.parse(resource.content));
    if ((document.model.adapter ?? 'openai') !== 'openai'
      || !['openai', 'ollama', 'litellm'].includes(document.model.provider ?? 'openai')) {
      throw new TeamError(400, 'Team execution currently requires a local OpenAI-compatible model.');
    }
    return document;
  }

  private admitCurrent(runtime: Runtime, teamId: string, id: string, version: number): TeamModelAdmission {
    const configured = this.runtime(runtime.id);
    if (runtimeRevision(this.config, configured) !== runtimeRevision(this.config, runtime)) throw new TeamError(403, 'Runtime identity changed.');
    const member = this.member(runtime.actorId, teamId); const resource = this.resource(teamId, id);
    const binding = this.binding(id);
    if (!binding?.enabled || binding.version !== version || resource.version !== version) {
      throw new TeamError(403, 'Enable execution for the current team model revision first.');
    }
    const source = this.runtime(binding.runtime_id); const sourceRevision = runtimeRevision(this.config, source);
    const sourceMember = this.member(source.actorId, teamId);
    const grant = source.modelGrants?.find(value => value.id === binding.grant_id);
    if (sourceRevision !== binding.runtime_revision || sourceMember.member !== binding.member_generation
      || sourceMember.auth !== binding.auth_revision || !grant
      || this.ledger.modelGeneration(source, sourceRevision, grant) !== binding.grant_generation) {
      throw new TeamError(403, 'The shared local model grant ended. Enable it again before use.');
    }
    const document = this.document(resource);
    if (!grant.models.includes(document.model.name)) throw new TeamError(403, 'Model is not granted.');
    // Narrow an owner grant to this one shared model. Never return host paths or
    // credentials in browser/runtime projections of this internal admission.
    const narrowed = { ...grant, models: [document.model.name] };
    return { teamId, resourceId: id, teamName: resource.teamName, version, document, grant: narrowed,
      generation: digest(JSON.stringify([runtime.id, runtimeRevision(this.config, runtime), member,
        binding.generation, binding.runtime_revision, binding.grant_generation, sourceMember, version])) };
  }

  admit(runtime: Runtime, teamId: string, id: string, version: number): TeamModelAdmission {
    return this.ledger.transaction(() => this.admitCurrent(runtime, teamId, id, version));
  }

  current(runtime: Runtime, admission: Pick<TeamModelAdmission, 'teamId' | 'resourceId' | 'version' | 'generation'>): boolean {
    try { return this.admit(runtime, admission.teamId, admission.resourceId, admission.version).generation === admission.generation; }
    catch { return false; }
  }

  resolve(runtime: Runtime, teamId: string, id: string): TeamModelAdmission {
    return this.ledger.transaction(() => this.resolveWithinTransaction(runtime, teamId, id));
  }

  /** Internal composition seam: the Flow closure caller already owns the
   * synchronous ledger transaction. Do not open a nested SQLite transaction. */
  resolveWithinTransaction(runtime: Runtime, teamId: string, id: string): TeamModelAdmission {
    // Check membership before reading even the current revision number.
    this.member(runtime.actorId, teamId);
    return this.admitCurrent(runtime, teamId, id, this.resource(teamId, id).version);
  }

  catalogue(runtime: Runtime, after = '') {
    if (after && !ID.test(after)) throw new TeamError(400, 'Invalid catalogue cursor.');
    return this.ledger.transaction(() => {
      this.runtime(runtime.id);
      const rows = this.ledger.db.prepare(`SELECT r.id,r.team_id AS teamId,r.version FROM team_resources r
        JOIN teams t ON t.id=r.team_id JOIN team_members m ON m.team_id=t.id
        JOIN team_model_access a ON a.resource_id=r.id
        WHERE m.actor_id=? AND m.state='member' AND t.archived=0 AND r.format=?
        AND a.enabled=1 AND a.version=r.version AND r.id>? ORDER BY r.id LIMIT 9`).all(runtime.actorId, SHARED_MODEL_FORMAT, after);
      const entries = [];
      for (const row of rows.slice(0, 8)) {
        try {
          const admission = this.admitCurrent(runtime, String(row.teamId), String(row.id), Number(row.version));
          const reference: TeamModelReference = { teamId: admission.teamId, resourceId: admission.resourceId,
            teamName: admission.teamName, version: admission.version, generation: admission.generation };
          // Zod's default object projection removes prompts, endpoints and all
          // other configuration fields from selector metadata.
          entries.push(teamModelSummarySchema.parse({ reference, model: admission.document.model }));
        } catch (error) { if (!(error instanceof TeamError)) throw error; }
      }
      return { entries, next: rows.length > 8 ? String(rows[7].id) : null };
    });
  }

  describe(session: Session, teamId: string, id: string): TeamModelAccessState {
    return this.teams.withMember(session, teamId, () => {
      const resource = this.resource(teamId, id); const binding = this.binding(id);
      let enabled = false; const options: TeamModelAccessState['options'] = [];
      try {
        const runtime = this.runtime(session.runtimeId); const document = this.document(resource);
        for (const grant of runtime.modelGrants ?? []) {
          if (grant.models.includes(document.model.name) && this.ledger.modelGeneration(runtime, runtimeRevision(this.config, runtime), grant) !== null) {
            options.push({ id: grant.id, model: document.model.name });
          }
        }
        try { this.admitCurrent(runtime, teamId, id, resource.version); enabled = true; } catch { /* No current execution permission. */ }
      } catch { /* A configuration can remain editable without a runnable service. */ }
      return { generation: binding?.generation ?? 0, enabled, version: resource.version,
        grantedBy: binding ? this.config.runtimes.find(runtime => runtime.id === binding.runtime_id)?.actorId ?? null : null,
        options, history: this.ledger.db.prepare(`SELECT actor_id AS actorId,time,action,version,generation
          FROM team_model_access_events WHERE resource_id=? ORDER BY sequence DESC`).all(id) as unknown as TeamModelAccessState['history'] };
    });
  }

  private event(session: Session, id: string, action: string, version: number, generation: number): void {
    this.ledger.db.prepare('INSERT INTO team_model_access_events(resource_id,actor_id,time,action,version,generation) VALUES(?,?,?,?,?,?)')
      .run(id, session.actorId, Date.now(), action, version, generation);
    this.ledger.db.prepare(`DELETE FROM team_model_access_events WHERE resource_id=? AND sequence NOT IN
      (SELECT sequence FROM team_model_access_events WHERE resource_id=? ORDER BY sequence DESC LIMIT 200)`).run(id, id);
  }

  authorize(session: Session, teamId: string, id: string, version: number, generation: number, grantId: string): void {
    this.teams.withMember(session, teamId, memberGeneration => {
      const resource = this.resource(teamId, id); const binding = this.binding(id);
      if (resource.version !== version || (binding?.generation ?? 0) !== generation) throw new TeamError(409, 'Model or execution permission changed. Reload before enabling it.');
      const runtime = this.runtime(session.runtimeId); const revision = runtimeRevision(this.config, runtime);
      if (runtime.actorId !== session.actorId) throw new TeamError(403, 'Local model owner mismatch.');
      const document = this.document(resource); const grant = runtime.modelGrants?.find(value => value.id === grantId);
      const grantGeneration = grant ? this.ledger.modelGeneration(runtime, revision, grant) : null;
      if (!grant || grantGeneration === null || !grant.models.includes(document.model.name)) throw new TeamError(403, 'Choose one of your current local model grants.');
      const member = this.member(session.actorId, teamId); const next = generation + 1;
      this.ledger.db.prepare(`INSERT INTO team_model_access(resource_id,generation,enabled,version,runtime_id,runtime_revision,
        grant_id,grant_generation,member_generation,auth_revision) VALUES(?,?,1,?,?,?,?,?,?,?)
        ON CONFLICT(resource_id) DO UPDATE SET generation=excluded.generation,enabled=1,version=excluded.version,
        runtime_id=excluded.runtime_id,runtime_revision=excluded.runtime_revision,grant_id=excluded.grant_id,
        grant_generation=excluded.grant_generation,member_generation=excluded.member_generation,auth_revision=excluded.auth_revision`)
        .run(id, next, version, runtime.id, revision, grant.id, grantGeneration, memberGeneration, member.auth);
      this.event(session, id, 'enabled', version, next);
    });
  }

  revoke(session: Session, teamId: string, id: string, generation: number): void {
    this.teams.withMember(session, teamId, () => {
      const resource = this.resource(teamId, id); const binding = this.binding(id);
      if (!binding || binding.generation !== generation) throw new TeamError(409, 'Execution permission changed. Reload before disabling it.');
      this.ledger.db.prepare('UPDATE team_model_access SET enabled=0,generation=generation+1 WHERE resource_id=?').run(id);
      this.event(session, id, 'disabled', resource.version, generation + 1);
    });
  }

  hasAccess(runtime: Runtime): boolean {
    return Boolean(this.ledger.db.prepare(`SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id
      JOIN team_resources r ON r.team_id=t.id JOIN team_model_access b ON b.resource_id=r.id
      JOIN runtimes source ON source.id=b.runtime_id JOIN actors a ON a.id=source.actor_id
      JOIN runtime_model_grants g ON g.runtime_id=source.id AND g.id=b.grant_id
      JOIN team_members owner ON owner.actor_id=source.actor_id AND owner.team_id=t.id
      JOIN runtime_lifecycle l ON l.runtime_id=source.id
      WHERE m.actor_id=? AND m.state='member' AND t.archived=0 AND b.enabled=1 AND b.version=r.version
      AND source.enabled=1 AND source.revision=b.runtime_revision AND a.enabled=1 AND a.auth_revision=b.auth_revision
      AND owner.state='member' AND owner.generation=b.member_generation
      AND g.enabled=1 AND g.configured=1 AND g.generation=b.grant_generation
      AND l.desired='running' AND l.phase='confirmed' AND l.verified_at>? AND json_extract(l.policy,'$.credentialExpiresAt')>?
      AND NOT EXISTS(SELECT 1 FROM runtime_rotations rotation WHERE rotation.runtime_id=source.id AND rotation.phase!='complete')
      LIMIT 1`).get(runtime.actorId, Date.now() - 30_000, Date.now()));
  }
}
