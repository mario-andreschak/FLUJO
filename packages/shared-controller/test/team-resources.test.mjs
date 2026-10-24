import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { digest, Ledger } from '../dist/ledger.js';
import { Teams, TeamError } from '../dist/teams.js';
import { RESOURCE_BYTES, RESOURCE_KINDS, TeamResources } from '../dist/team-resources.js';
import { modelConfigurationFields, publishableModel, readSharedModel, SHARED_MODEL_FORMAT } from '../dist/shared-model.js';
import { TeamModelAccess } from '../dist/team-model-access.js';
import { projectSharedMcp, readSharedMcp, sharedMcpDraftSchema, SHARED_MCP_FORMAT } from '../dist/shared-mcp.js';
import { flowDependencies, projectSharedFlow, readSharedFlow, setFlowDependency, sharedFlowDraftSchema, SHARED_FLOW_FORMAT, teamDependencyId } from '../dist/shared-flow.js';
import { privateFixture } from './private-fixture.mjs';

const password = 'local resource fixture password';
const status = code => error => error instanceof TeamError && error.status === code;
const flowDocument = (properties = {}) => ({ format: SHARED_FLOW_FORMAT, flow: { name: 'Team graph', nodes: [
  { id: 'process', type: 'process', position: { x: 100, y: 200 }, data: { type: 'process', label: 'Answer', properties } },
], edges: [] } });
const mcpDocument = (fields = {}) => ({ format: SHARED_MCP_FORMAT,
  mcp: { name: 'Team server', transport: 'stdio', command: 'node', args: ['server.mjs'], ...fields } });

test('MCP publication removes private executable arguments, credentials and capabilities before review', () => {
  const projected = projectSharedMcp({ name: 'Server', transport: 'stdio', command: 'C:/private/node',
    args: ['--token=private-token'], env: { TOKEN: 'private-secret' }, roots: ['C:/private/root'],
    rootPath: 'C:/private/root', headers: { Authorization: 'private-header' }, oauthTokens: 'private-oauth',
    toolParameterPresets: { call: { key: 'private-preset' } }, sampling: { enabled: true, modelId: 'private-model' },
    enableMcpApps: true, enableMcpSkills: true, exposeAsMcpServer: true, trustedHost: {}, isolation: {},
    launch: { command: 'private-launch' }, _installCommand: 'private-install', _buildCommand: 'private-build' });
  assert.deepEqual(projected.document, { format: SHARED_MCP_FORMAT, mcp: { name: 'Server', transport: 'stdio', command: '', args: [] } });
  assert.ok(projected.omitted.includes('args')); assert.ok(projected.omitted.includes('oauthTokens'));
  assert.ok(!JSON.stringify(projected).includes('private-'));
  assert.throws(() => readSharedMcp(projected.document));
  for (const serverUrl of ['https://user:pass@example.com/mcp', 'https://example.com/mcp?token=secret', 'file:///private/file', '${global:ENDPOINT}']) {
    const copy = projectSharedMcp({ name: 'Remote', transport: 'streamable', serverUrl });
    assert.equal(copy.document.mcp.serverUrl, ''); assert.ok(copy.omitted.includes('serverUrl'));
  }
});

test('MCP typed documents reject private fields, mismatched transports, ambient bindings and unbounded inputs', () => {
  for (const field of ['env', 'headers', 'oauthTokens', 'roots', 'rootPath', 'sampling', 'elicitation', 'trustedHost', 'isolation', 'toolParameterPresets', 'launch', 'enableMcpApps', 'runtimeHomeMode']) {
    assert.throws(() => readSharedMcp(mcpDocument({ [field]: {} })), field);
  }
  for (const fields of [{ command: '' }, { command: '${global:COMMAND}' }, { args: ['${kv:secret}'] },
    { args: ['bad\u0000argument'] }, { args: Array(257).fill('arg') }, { serverUrl: 'https://example.com' },
    { environmentKeys: ['TOKEN', 'token'] }, { environmentKeys: ['SECRET=value'] }, { name: ' ' }]) {
    assert.throws(() => readSharedMcp(mcpDocument(fields)), JSON.stringify(fields));
  }
  for (const transport of ['streamable', 'sse', 'websocket']) {
    const mcp = { name: 'Remote', transport, [transport === 'websocket' ? 'websocketUrl' : 'serverUrl']:
      transport === 'websocket' ? 'wss://example.com/mcp' : 'https://example.com/mcp' };
    assert.deepEqual(readSharedMcp({ format: SHARED_MCP_FORMAT, mcp }).mcp, mcp);
    assert.throws(() => readSharedMcp({ format: SHARED_MCP_FORMAT, mcp: { ...mcp, command: 'node' } }));
    assert.throws(() => readSharedMcp({ format: SHARED_MCP_FORMAT, mcp: { ...mcp, headerNames: ['bad:header'] } }));
  }
});

test('MCP draft roundtrips incomplete fields but cannot carry unrecognized private payloads', () => {
  const draft = { format: 'flujo.mcp.draft.v1', document: { format: SHARED_MCP_FORMAT,
    mcp: { name: '', transport: 'streamable', serverUrl: 'unfinished://', headerNames: [''] } } };
  assert.deepEqual(sharedMcpDraftSchema.parse(draft), draft);
  assert.throws(() => readSharedMcp(draft.document));
  assert.throws(() => sharedMcpDraftSchema.parse({ ...draft, document: mcpDocument({ env: { SECRET: 'value' } }) }));
});

test('typed MCP resources enforce member editing, immutable format and revalidation on restore', async t => {
  const f = await fixture(t); f.joinBob(); const resources = new TeamResources(f.ledger); const { alice, bob, charlie } = f.sessions;
  const content = JSON.stringify(mcpDocument());
  assert.throws(() => resources.create(alice, f.teamId, 'model', 'Wrong kind', content), status(400));
  const id = resources.create(alice, f.teamId, 'mcp', 'Server', content);
  assert.equal(resources.read(bob, f.teamId, id).resource.format, SHARED_MCP_FORMAT);
  assert.throws(() => resources.read(charlie, f.teamId, id), status(404));
  const lease = resources.acquire(bob, f.teamId, id, 1);
  assert.throws(() => resources.acquire(alice, f.teamId, id, 1), status(423));
  for (const invalid of ['{}', JSON.stringify(mcpDocument({ env: { SECRET: 'secret' } }))]) {
    assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Invalid', invalid), status(400));
  }
  assert.equal(resources.read(bob, f.teamId, id).editor.actorId, 'bob');
  resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Updated', JSON.stringify(mcpDocument({ args: ['updated.mjs'] })));
  assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Stale', content), status(409));
  resources.restore(alice, f.teamId, id, 2, 1);
  assert.deepEqual(readSharedMcp(JSON.parse(resources.read(bob, f.teamId, id).revision.content)), mcpDocument());
  f.ledger.db.prepare('UPDATE team_resource_versions SET content=? WHERE resource_id=? AND version=1')
    .run(JSON.stringify(mcpDocument({ roots: ['/private'] })), id);
  assert.throws(() => resources.restore(alice, f.teamId, id, 3, 1), status(400));
  assert.equal(resources.read(alice, f.teamId, id).resource.version, 3);
  const graph = flowDocument({ boundServer: teamDependencyId('mcp', f.teamId, id) });
  graph.flow.nodes[0].type = 'mcp'; graph.flow.nodes[0].data.type = 'mcp';
  assert.ok(resources.create(bob, f.teamId, 'flow', 'Bound server', JSON.stringify(graph)));
});
async function fixture(t) {
  const { directory, close } = privateFixture(t);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    runtimes: ['alice', 'bob', 'charlie'].map((id, index) => ({ id, actorId: id,
      origin: `https://${id}.localhost:4280`, upstream: `http://127.0.0.1:${4400 + index}`,
      credential: `flo_v1_${String(index).repeat(43)}`, isolationId: `fixture:${id}` })) });
  let ledger = new Ledger(directory); ledger.reconcile(config); close.push(() => ledger.close());
  const tokens = {}; const sessions = {};
  const login = async actor => {
    const runtime = config.runtimes.find(runtime => runtime.actorId === actor); const revision = runtimeRevision(config, runtime);
    const token = await ledger.authenticate(runtime, revision, password, 3600);
    const session = ledger.session(token, runtime, revision); assert.ok(session); return { token, session };
  };
  for (const runtime of config.runtimes) {
    await ledger.setPassword(runtime, runtimeRevision(config, runtime), password);
    const auth = await login(runtime.actorId); tokens[runtime.actorId] = auth.token; sessions[runtime.actorId] = auth.session;
  }
  const teams = new Teams(ledger); const teamId = teams.create(sessions.alice, 'Local resources');
  const joinBob = () => {
    teams.invite(sessions.alice, teamId, teams.detail(sessions.alice, teamId).team.generation, 'bob');
    teams.respond(sessions.bob, teamId, teams.list(sessions.bob).invitations[0].invitation, true);
  };
  return { get ledger() { return ledger; }, directory, close, config, teams, teamId, sessions, tokens, login, joinBob,
    reopen() { ledger.close(); ledger = new Ledger(directory); ledger.reconcile(config); return new TeamResources(ledger); } };
}

test('only accepted members read submitted resources; resource IDs and kind labels grant no private runtime access', async t => {
  const f = await fixture(t); const resources = new TeamResources(f.ledger); const { alice, bob, charlie } = f.sessions;
  const ids = RESOURCE_KINDS.map(kind => resources.create(alice, f.teamId, kind, `Shared ${kind}`, '{"privateDependency":"unresolved"}'));
  f.teams.invite(alice, f.teamId, f.teams.detail(alice, f.teamId).team.generation, 'bob');
  assert.throws(() => resources.list(bob, f.teamId), status(404));
  assert.throws(() => resources.read(charlie, f.teamId, ids[0]), status(404));
  assert.throws(() => resources.history(charlie, f.teamId, ids[0]), status(404));
  assert.throws(() => resources.create(charlie, f.teamId, 'model', 'Unknown team', '{}'), status(404));
  f.teams.respond(bob, f.teamId, f.teams.list(bob).invitations[0].invitation, true);
  assert.deepEqual(resources.list(bob, f.teamId).map(row => row.kind).sort(), [...RESOURCE_KINDS].sort());
  const otherTeam = f.teams.create(bob, 'Another team');
  assert.throws(() => resources.read(bob, otherTeam, ids[0]), status(404));
  const data = resources.read(bob, f.teamId, ids[0]);
  assert.deepEqual(JSON.parse(data.revision.content), { privateDependency: 'unresolved' });
  assert.equal(data.revision.digest, digest(data.revision.content));
  assert.equal(data.revision.actorId, 'alice');
  assert.deepEqual(Object.keys(data.resource).sort(), ['createdAt', 'creatorId', 'format', 'id', 'kind', 'name', 'teamId', 'version']);
  assert.throws(() => resources.list({ ...alice, actorId: 'bob' }, f.teamId), status(401));
});

test('two database connections enforce one editor, session-bound fences, and immutable compare-and-save history', async t => {
  const f = await fixture(t); f.joinBob(); const resources = new TeamResources(f.ledger); const { alice, bob } = f.sessions;
  const second = new Ledger(f.directory); f.close.unshift(() => second.close()); const concurrent = new TeamResources(second);
  const id = resources.create(alice, f.teamId, 'flow', 'First name', '{"step":1}');
  const lease = resources.acquire(alice, f.teamId, id, 1);
  assert.throws(() => concurrent.acquire(bob, f.teamId, id, 1), status(423));
  assert.throws(() => resources.acquire(alice, f.teamId, id, 1), status(423));
  const alternate = await f.login('alice');
  assert.throws(() => resources.save(alternate.session, f.teamId, id, lease.token, lease.fence, 1, 'Impostor tab', '{}'), status(409));
  assert.throws(() => concurrent.release(bob, f.teamId, id, lease.token, lease.fence), status(409));
  assert.throws(() => resources.renew(alice, f.teamId, id, 'x'.repeat(43), lease.fence), status(409));
  assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence + 1, 1, 'Wrong fence', '{}'), status(409));
  f.teams.rename(alice, f.teamId, f.teams.detail(alice, f.teamId).team.generation, 'Renaming does not evict an editor');
  assert.ok(resources.renew(alice, f.teamId, id, lease.token, lease.fence) > Date.now());
  assert.equal(resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Second name', '{"step":2}'), 2);
  assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Repeated save', '{}'), status(409));
  assert.throws(() => concurrent.acquire(bob, f.teamId, id, 1), status(409));
  const next = concurrent.acquire(bob, f.teamId, id, 2); assert.ok(next.fence > lease.fence);
  assert.throws(() => resources.restore(alice, f.teamId, id, 2, 1), status(423));
  concurrent.release(bob, f.teamId, id, next.token, next.fence);
  assert.equal(resources.restore(bob, f.teamId, id, 2, 1), 3);
  const restored = resources.read(alice, f.teamId, id);
  assert.equal(restored.revision.name, 'First name'); assert.equal(restored.revision.restoredFrom, 1);
  assert.equal(restored.revision.actorId, 'bob'); assert.equal(restored.revision.content, resources.read(alice, f.teamId, id, 1).revision.content);
  assert.equal(resources.read(alice, f.teamId, id, 2).revision.name, 'Second name');
  assert.deepEqual(resources.history(bob, f.teamId, id).map(row => row.version), [3, 2, 1]);
  assert.ok(resources.history(bob, f.teamId, id).every(row => !Object.hasOwn(row, 'content')));
  assert.throws(() => resources.restore(alice, f.teamId, id, 2, 1), status(409));
});

test('expiry, removal and reinvitation, logout and restart never revive old edit leases', async t => {
  const f = await fixture(t); f.joinBob(); let resources = new TeamResources(f.ledger); const { alice, bob } = f.sessions;
  const id = resources.create(alice, f.teamId, 'chat', 'Conversation snapshot', '[]');
  const expired = resources.acquire(alice, f.teamId, id, 1);
  f.ledger.db.prepare('UPDATE team_resources SET lease_expires_at=? WHERE id=?').run(Date.now() - 1, id);
  assert.throws(() => resources.renew(alice, f.teamId, id, expired.token, expired.fence), status(409));
  const removed = resources.acquire(bob, f.teamId, id, 1);
  f.teams.remove(alice, f.teamId, f.teams.detail(alice, f.teamId).team.generation, 'bob');
  assert.throws(() => resources.save(bob, f.teamId, id, removed.token, removed.fence, 1, 'Removed', '[]'), status(404));
  f.joinBob();
  assert.throws(() => resources.renew(bob, f.teamId, id, removed.token, removed.fence), status(409));
  const loggedOut = resources.acquire(bob, f.teamId, id, 1);
  f.ledger.revokeSession(f.tokens.bob);
  assert.throws(() => resources.save(bob, f.teamId, id, loggedOut.token, loggedOut.fence, 1, 'Logged out', '[]'), status(401));
  const beforeRestart = resources.acquire(alice, f.teamId, id, 1); resources = f.reopen();
  assert.equal(resources.read(alice, f.teamId, id).editor, null);
  assert.equal(resources.read(alice, f.teamId, id).resource.version, 1);
  assert.throws(() => resources.renew(alice, f.teamId, id, beforeRestart.token, beforeRestart.fence), status(409));
  const afterRestart = resources.acquire(alice, f.teamId, id, 1); assert.ok(afterRestart.fence > beforeRestart.fence);
  assert.equal(resources.save(alice, f.teamId, id, afterRestart.token, afterRestart.fence, 1, 'After restart', '[{"text":"local"}]'), 2);
});

test('archive and account recovery revoke locks and all subsequent reads use current authority', async t => {
  const f = await fixture(t); f.joinBob(); const resources = new TeamResources(f.ledger); const { alice, bob } = f.sessions;
  const id = resources.create(alice, f.teamId, 'execution', 'Result', '{}');
  const old = resources.acquire(bob, f.teamId, id, 1);
  const runtime = f.config.runtimes[1];
  await f.ledger.setPassword(runtime, runtimeRevision(f.config, runtime), password);
  assert.throws(() => resources.save(bob, f.teamId, id, old.token, old.fence, 1, 'Old session', '{}'), status(401));
  const current = await f.login('bob');
  assert.throws(() => resources.renew(current.session, f.teamId, id, old.token, old.fence), status(409));
  const lease = resources.acquire(alice, f.teamId, id, 1);
  f.teams.archive(alice, f.teamId, f.teams.detail(alice, f.teamId).team.generation);
  assert.throws(() => resources.list(alice, f.teamId), status(404));
  assert.throws(() => resources.history(current.session, f.teamId, id), status(404));
  assert.throws(() => resources.release(alice, f.teamId, id, lease.token, lease.fence), status(404));
  assert.equal(f.ledger.db.prepare('SELECT count(*) AS n FROM team_resource_versions').get().n, 1);
});

test('malformed or oversized drafts and storage failures leave history and the current editor intact', async t => {
  const f = await fixture(t); const resources = new TeamResources(f.ledger); const { alice } = f.sessions;
  const id = resources.create(alice, f.teamId, 'mcp', 'Original', '{}'); const lease = resources.acquire(alice, f.teamId, id, 1);
  for (const content of ['broken json', 'null', 'true', '{"__proto__":{}}', '{"nested":{"constructor":{}}}']) {
    assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Invalid', content), status(400));
  }
  for (const content of [`["${'x'.repeat(RESOURCE_BYTES)}"]`, '['.repeat(66) + '0' + ']'.repeat(66), JSON.stringify(Array(50001).fill(0))]) {
    assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Too large', content), status(413));
  }
  assert.throws(() => resources.create(alice, f.teamId, 'unknown', 'Unknown kind', '{}'), status(400));
  assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'name\u202eevil', '{}'), status(400));
  f.ledger.db.exec("CREATE TRIGGER resource_fixture_failure BEFORE UPDATE OF version ON team_resources BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
  assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Rolled back', '{"new":true}'), /fixture storage failure/);
  f.ledger.db.exec('DROP TRIGGER resource_fixture_failure');
  assert.equal(resources.history(alice, f.teamId, id).length, 1);
  assert.equal(resources.read(alice, f.teamId, id).resource.name, 'Original');
  f.ledger.db.prepare('UPDATE team_resource_versions SET bytes=? WHERE resource_id=?').run(128 * 1024 * 1024, id);
  assert.throws(() => resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Over quota', '{}'), status(409));
  assert.equal(resources.read(alice, f.teamId, id).resource.version, 1);
  f.ledger.db.prepare('UPDATE team_resource_versions SET bytes=2 WHERE resource_id=?').run(id);
  assert.equal(resources.save(alice, f.teamId, id, lease.token, lease.fence, 1, 'Recovered', '{}'), 2);
});

test('schema 6 upgrade preserves membership and account sessions without publishing private resources', async t => {
  const f = await fixture(t); f.joinBob();
  f.ledger.db.exec('DROP TABLE team_resource_versions; DROP TABLE team_resources; PRAGMA user_version=6;');
  const resources = f.reopen(); const teams = new Teams(f.ledger);
  assert.equal(f.ledger.db.prepare('PRAGMA user_version').get().user_version, 9);
  for (const session of [f.sessions.alice, f.sessions.bob]) {
    assert.equal(f.ledger.sessionCurrent(session), true);
    assert.equal(teams.list(session).teams[0].id, f.teamId);
    assert.deepEqual(resources.list(session, f.teamId), []);
  }
});

test('native model publication projects configuration and every later edit rejects secrets or format downgrade', async t => {
  const f = await fixture(t); f.joinBob(); const resources = new TeamResources(f.ledger); const { alice, bob } = f.sessions;
  const source = { id: 'private-id', name: 'fixture-local', displayName: 'Team model', provider: 'ollama', adapter: 'openai',
    ApiKey: 'private-fixture-key', folder: 'private-folder', favorite: true, unknownCredential: 'private-extension',
    baseUrl: 'http://127.0.0.1:11434/v1', promptTemplate: 'Use the shared prompt.', maxTokens: 500 };
  const document = publishableModel(source);
  assert.deepEqual(Object.keys(document.model).sort(), ['adapter', 'baseUrl', 'displayName', 'maxTokens', 'name', 'promptTemplate', 'provider']);
  assert.ok(!JSON.stringify(document).includes('private-'));
  assert.throws(() => publishableModel({ ...source, ownerCredentialBinding: { ownerId: 'alice', credentialId: 'private' } }), /private credential binding/);
  assert.throws(() => publishableModel({ ...source, fallbackPolicy: { candidates: ['private-model'] } }), /routing policy/);
  for (const baseUrl of ['https://user:secret@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'file:///private']) {
    assert.throws(() => publishableModel({ ...source, baseUrl }), /Invalid shared model/);
  }
  assert.deepEqual(modelConfigurationFields({ ApiKey: 'secret', id: 'private', name: '', maxTokens: -1 }), { name: '', maxTokens: -1 });
  assert.throws(() => readSharedModel({ ...document, model: { ...document.model, ApiKey: 'secret' } }), /Invalid shared model/);
  const id = resources.create(alice, f.teamId, 'model', 'Team model', JSON.stringify(document));
  assert.equal(resources.read(bob, f.teamId, id).resource.format, SHARED_MODEL_FORMAT);
  const lease = resources.acquire(bob, f.teamId, id, 1);
  for (const content of ['{}', JSON.stringify({ ...document, model: { ...document.model, ApiKey: 'injected' } }),
    JSON.stringify({ ...document, model: { ...document.model, ownerCredentialBinding: { ownerId: 'alice', credentialId: 'private' } } })]) {
    assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Invalid edit', content), status(400));
  }
  assert.equal(resources.history(alice, f.teamId, id).length, 1);
  const revised = { ...document, model: { ...document.model, displayName: 'Edited by Bob', maxTokens: 1000 } };
  assert.equal(resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Edited by Bob', JSON.stringify(revised)), 2);
  assert.equal(readSharedModel(JSON.parse(resources.read(alice, f.teamId, id).revision.content)).model.maxTokens, 1000);
  assert.equal(resources.restore(alice, f.teamId, id, 2, 1), 3);
  assert.equal(readSharedModel(JSON.parse(resources.read(bob, f.teamId, id).revision.content)).model.maxTokens, 500);
});

test('schema 7 migration retains legacy JSON as passive documents without upgrading user-supplied format tags', async t => {
  const f = await fixture(t); const resources = new TeamResources(f.ledger); const { alice } = f.sessions;
  const id = resources.create(alice, f.teamId, 'model', 'Legacy JSON', '{}');
  const legacy = JSON.stringify({ format: SHARED_MODEL_FORMAT, model: { name: 'legacy', ApiKey: 'fixture legacy content' } });
  f.ledger.db.prepare('UPDATE team_resource_versions SET content=?,digest=?,bytes=? WHERE resource_id=?')
    .run(legacy, digest(legacy), Buffer.byteLength(legacy), id);
  f.ledger.db.exec('ALTER TABLE team_resources DROP COLUMN format; PRAGMA user_version=7;');
  const reopened = f.reopen(); const saved = reopened.read(alice, f.teamId, id);
  assert.equal(saved.resource.format, 'json'); assert.equal(saved.revision.content, legacy);
  assert.equal(f.ledger.db.prepare('PRAGMA user_version').get().user_version, 9);
});

test('schema 8 upgrade preserves model configuration and grants no execution automatically', async t => {
  const f = await fixture(t); const resources = new TeamResources(f.ledger);
  const document = publishableModel({ name: 'local-fixture', provider: 'ollama', adapter: 'openai' });
  const id = resources.create(f.sessions.alice, f.teamId, 'model', 'Configuration only', JSON.stringify(document));
  const previous = resources.read(f.sessions.alice, f.teamId, id);
  f.ledger.db.exec('DROP TABLE team_model_access_events; DROP TABLE team_model_access; PRAGMA user_version=8;');
  const reopened = f.reopen();
  assert.deepEqual(reopened.read(f.sessions.alice, f.teamId, id), previous);
  assert.equal(f.ledger.db.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(new TeamModelAccess(f.config, f.ledger).describe(f.sessions.alice, f.teamId, id).enabled, false);
});

test('Flow publication projects authored graph fields, clears private bindings and rejects embedded authority', () => {
  const source = flowDocument({ boundModel: 'private-model', promptTemplate: 'Reviewed prompt', ApiKey: 'private-key',
    captureVariable: '${global:private-token}', maxTurns: 4 }).flow;
  source.nodes.push({ id: 'sub', type: 'subflow', position: { x: 300, y: 200 }, data: { type: 'subflow', label: 'Delegate',
    properties: { subflowId: 'private-flow', parallelSubflowIds: ['private-one', 'private-two'], parallelSubflowIdsVar: 'private-var' } } });
  source.edges.push({ id: 'edge', source: 'process', target: 'sub', type: 'custom', sourceHandle: 'right', targetHandle: 'left',
    data: { edgeType: 'standard', condition: { expression: 'result.ok' } }, selected: true });
  const result = projectSharedFlow(source);
  assert.equal(result.document.flow.nodes[0].data.properties.promptTemplate, 'Reviewed prompt');
  assert.equal(result.document.flow.nodes[0].data.properties.maxTurns, 4);
  assert.deepEqual(result.omitted, ['Step 1: ApiKey', 'Step 1: captureVariable', 'Step 2: parallelSubflowIdsVar']);
  assert.ok(!JSON.stringify(result.document).includes('private-'));
  assert.ok(flowDependencies(result.document).every(slot => slot.value === ''));
  assert.equal(flowDependencies(result.document).length, 4);
  assert.equal(result.document.flow.edges[0].source, 'process');
  assert.ok(!Object.hasOwn(result.document.flow.edges[0], 'selected'));
  for (const field of ['executionDependencies', 'personaOwnership', 'behaviorRules', 'permissionRules']) {
    assert.throws(() => projectSharedFlow({ ...source, [field]: {} }), /private execution or Persona authority/);
  }
  const draft = { format: 'flujo.flow.draft.v1', document: result.document, pendingFields: { 'process:maxTurns': 'unfinished[' } };
  assert.deepEqual(sharedFlowDraftSchema.parse(draft), draft);
  assert.throws(() => sharedFlowDraftSchema.parse({ ...draft, pendingFields: { 'removed:maxTurns': 'unfinished[' } }));
});

test('typed Flow dependencies must exist in the same team with the expected kind and format', async t => {
  const f = await fixture(t); const resources = new TeamResources(f.ledger); const { alice } = f.sessions;
  const model = JSON.stringify(publishableModel({ name: 'fixture', provider: 'ollama', adapter: 'openai' }));
  const modelId = resources.create(alice, f.teamId, 'model', 'Local model', model);
  const legacyId = resources.create(alice, f.teamId, 'model', 'Passive document', '{}');
  const otherTeam = f.teams.create(alice, 'Other team');
  const foreignId = resources.create(alice, otherTeam, 'model', 'Other model', model);
  const create = document => resources.create(alice, f.teamId, 'flow', 'Shared graph', JSON.stringify(document));
  for (const reference of ['private-model', '', teamDependencyId('model', f.teamId, 'x'.repeat(43)),
    teamDependencyId('model', otherTeam, foreignId), teamDependencyId('model', f.teamId, foreignId),
    teamDependencyId('model', f.teamId, legacyId), teamDependencyId('flow', f.teamId, modelId)]) {
    assert.throws(() => create(flowDocument({ boundModel: reference })), status(400));
  }
  const document = flowDocument({ boundModel: teamDependencyId('model', f.teamId, modelId) });
  const id = create(document); assert.equal(resources.read(alice, f.teamId, id).resource.format, SHARED_FLOW_FORMAT);
  assert.throws(() => resources.create(alice, f.teamId, 'chat', 'Wrong kind', JSON.stringify(document)), status(400));
  assert.equal(new TeamModelAccess(f.config, f.ledger).describe(alice, f.teamId, modelId).enabled, false);
  const badGraph = structuredClone(document); badGraph.flow.edges.push({ id: 'bad', source: 'process', target: 'missing' });
  assert.throws(() => create(badGraph), status(400));
  assert.throws(() => create(flowDocument({ boundModel: document.flow.nodes[0].data.properties.boundModel, mcpNodes: [] })), status(400));
});

test('Flow editing keeps immutable format and history, rejects stale editors and revalidates restored dependencies', async t => {
  const f = await fixture(t); f.joinBob(); const resources = new TeamResources(f.ledger); const { alice, bob } = f.sessions;
  const modelId = resources.create(alice, f.teamId, 'model', 'Model', JSON.stringify(publishableModel({ name: 'fixture', provider: 'ollama', adapter: 'openai' })));
  const document = flowDocument({ boundModel: teamDependencyId('model', f.teamId, modelId), promptTemplate: 'First prompt' });
  const id = resources.create(alice, f.teamId, 'flow', 'Original', JSON.stringify(document));
  const lease = resources.acquire(bob, f.teamId, id, 1);
  assert.throws(() => resources.acquire(alice, f.teamId, id, 1), status(423));
  for (const payload of ['{}', JSON.stringify({ ...document, format: 'json' })]) {
    assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Downgrade', payload), status(400));
  }
  const invalid = setFlowDependency(document, flowDependencies(document)[0], 'private-model');
  assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Private reference', JSON.stringify(invalid)), status(400));
  assert.equal(resources.read(bob, f.teamId, id).editor.actorId, 'bob');
  const revised = flowDocument({ promptTemplate: 'Edited by Bob' });
  assert.equal(resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Revised', JSON.stringify(revised)), 2);
  assert.throws(() => resources.save(bob, f.teamId, id, lease.token, lease.fence, 1, 'Stale', JSON.stringify(document)), status(409));
  assert.equal(resources.restore(alice, f.teamId, id, 2, 1), 3);
  assert.deepEqual(readSharedFlow(JSON.parse(resources.read(alice, f.teamId, id).revision.content), f.teamId), document);
  // A corrupt/missing dependency cannot be revived by restoring an old Flow revision.
  f.ledger.db.prepare("UPDATE team_resources SET format='json' WHERE id=?").run(modelId);
  assert.throws(() => resources.restore(alice, f.teamId, id, 3, 1), status(400));
  assert.equal(resources.read(alice, f.teamId, id).resource.version, 3);
  const legacyId = resources.create(alice, f.teamId, 'flow', 'Passive', '{}');
  const legacyLease = resources.acquire(alice, f.teamId, legacyId, 1);
  resources.save(alice, f.teamId, legacyId, legacyLease.token, legacyLease.fence, 1, 'Tagged JSON', JSON.stringify(revised));
  assert.equal(resources.read(alice, f.teamId, legacyId).resource.format, 'json');
});
