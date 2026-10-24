import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { digest, type Ledger } from './ledger.js';
import { TeamError } from './teams.js';
import { TeamModelAccess } from './team-model-access.js';
import { assertTeamFlowCapabilities, flowDependencies, readSharedFlow, SHARED_FLOW_FORMAT, TEAM_FLOW_BUNDLE_BYTES,
  type TeamFlowBundle, type TeamFlowReference } from './shared-flow.js';

const ID = /^[A-Za-z0-9_-]{43}$/;
type Resource = { resourceId: string; version: number; content: string };

/** Read authority is fixed by the host-owned runtime pipe. A bundle pins the
 * entire graph closure and each model grant; no private lookup is a fallback. */
export class TeamFlowAccess {
  private readonly models: TeamModelAccess;
  constructor(private readonly config: ControllerConfig, private readonly ledger: Ledger) {
    this.models = new TeamModelAccess(config, ledger);
  }
  private member(runtime: Runtime, teamId: string) {
    const configured = this.config.runtimes.find(value => value.id === runtime.id);
    if (!configured?.localRuntime || runtimeRevision(this.config, configured) !== runtimeRevision(this.config, runtime)
      || !this.ledger.available(configured, runtimeRevision(this.config, configured))) throw new TeamError(403, 'Local runtime unavailable.');
    const row = this.ledger.db.prepare(`SELECT m.generation,a.auth_revision,t.name FROM team_members m
      JOIN actors a ON a.id=m.actor_id JOIN teams t ON t.id=m.team_id
      WHERE m.team_id=? AND m.actor_id=? AND m.state='member' AND a.enabled=1 AND t.archived=0`).get(teamId, runtime.actorId);
    if (!row) throw new TeamError(403, 'Team Flow access ended.');
    return { generation: Number(row.generation), auth: Number(row.auth_revision), name: String(row.name) };
  }
  private resource(teamId: string, resourceId: string): Resource {
    if (!ID.test(teamId) || !ID.test(resourceId)) throw new TeamError(404, 'Team Flow unavailable.');
    const row = this.ledger.db.prepare(`SELECT r.id AS resourceId,r.version,v.content FROM team_resources r
      JOIN team_resource_versions v ON v.resource_id=r.id AND v.version=r.version
      WHERE r.team_id=? AND r.id=? AND r.kind='flow' AND r.format=?`).get(teamId, resourceId, SHARED_FLOW_FORMAT);
    if (!row) throw new TeamError(404, 'Team Flow unavailable.');
    return row as unknown as Resource;
  }
  resolve(runtime: Runtime, teamId: string, resourceId: string): TeamFlowBundle {
    return this.ledger.transaction(() => this.resolveWithinTransaction(runtime, teamId, resourceId));
  }
  private resolveWithinTransaction(runtime: Runtime, teamId: string, resourceId: string): TeamFlowBundle {
      const member = this.member(runtime, teamId);
      const flows = new Map<string, TeamFlowBundle['flows'][number]>();
      const models = new Map<string, TeamFlowBundle['models'][number]>();
      let bytes = 0;
      const visit = (id: string, path: string[]): void => {
        if (path.includes(id) || path.length > 8) throw new TeamError(400, 'Shared Flow dependency cycle or excessive depth.');
        // Do not skip a repeated subtree: its depth relative to this parent
        // still needs checking. Bounds cap both graph size and traversal work.
        if (++visits > 4096) throw new TeamError(413, 'Shared Flow dependency traversal is too large.');
        let item = flows.get(id);
        if (!item) {
          if (flows.size >= 128) throw new TeamError(413, 'Shared Flow dependency closure is too large.');
          const stored = this.resource(teamId, id);
          bytes += Buffer.byteLength(stored.content);
          if (bytes > TEAM_FLOW_BUNDLE_BYTES) throw new TeamError(413, 'Shared Flow dependency closure exceeds 2 MiB.');
          let document;
          try { document = readSharedFlow(JSON.parse(stored.content), teamId); assertTeamFlowCapabilities(document); }
          catch (error) { throw new TeamError(400, error instanceof Error ? error.message : 'Invalid shared Flow.'); }
          item = { resourceId: id, version: stored.version, document }; flows.set(id, item);
        }
        for (const dependency of flowDependencies(item.document)) {
          const target = dependency.value.split(':')[2];
          if (dependency.kind === 'flow') visit(target, [...path, id]);
          else if (dependency.kind === 'model' && !models.has(target)) {
            if (models.size >= 512) throw new TeamError(413, 'Too many shared model dependencies.');
            const model = this.models.resolveWithinTransaction(runtime, teamId, target);
            models.set(target, { teamId, resourceId: target, version: model.version, generation: model.generation });
          } else if (dependency.kind === 'mcp') throw new TeamError(403, 'Team MCP execution is not available yet.');
        }
      };
      let visits = 0; visit(resourceId, []);
      const documents = [...flows.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
      const modelReferences = [...models.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
      const version = flows.get(resourceId)!.version;
      const generation = digest(JSON.stringify([runtime.id, runtimeRevision(this.config, runtime), teamId, resourceId,
        member, documents.map(item => [item.resourceId, item.version, digest(JSON.stringify(item.document))]), modelReferences]));
      const bundle: TeamFlowBundle = { reference: { teamId, resourceId, teamName: member.name, version, generation }, flows: documents, models: modelReferences };
      if (Buffer.byteLength(JSON.stringify(bundle)) > TEAM_FLOW_BUNDLE_BYTES) throw new TeamError(413, 'Shared Flow bundle exceeds 2 MiB.');
      return bundle;
  }
  current(runtime: Runtime, expected: TeamFlowReference): boolean {
    try { return this.resolve(runtime, expected.teamId, expected.resourceId).reference.generation === expected.generation; }
    catch { return false; }
  }
  catalogue(runtime: Runtime, after = '') {
    if (after && !ID.test(after)) throw new TeamError(400, 'Invalid Flow catalogue cursor.');
    return this.ledger.transaction(() => {
      const rows = this.ledger.db.prepare(`SELECT r.id,r.team_id AS teamId FROM team_resources r
        JOIN teams t ON t.id=r.team_id JOIN team_members m ON m.team_id=t.id
        WHERE m.actor_id=? AND m.state='member' AND t.archived=0 AND r.format=? AND r.id>?
        ORDER BY r.id LIMIT 9`).all(runtime.actorId, SHARED_FLOW_FORMAT, after);
      const entries = [];
      for (const row of rows.slice(0, 8)) {
        try {
          const bundle = this.resolveWithinTransaction(runtime, String(row.teamId), String(row.id));
          const document = bundle.flows.find(item => item.resourceId === bundle.reference.resourceId)!.document;
          entries.push({ reference: bundle.reference, name: document.flow.name, ...(document.flow.description ? { description: document.flow.description } : {}) });
        } catch (error) { if (!(error instanceof TeamError)) throw error; }
      }
      return { entries, next: rows.length > 8 ? String(rows[7].id) : null };
    });
  }
}
