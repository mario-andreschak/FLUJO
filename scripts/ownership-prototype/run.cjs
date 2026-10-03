'use strict';
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { issueOwnerCredential } = require('./auth-source.cjs');

async function run() {
  const reportPath = process.argv[2];
  if (reportPath && !path.isAbsolute(reportPath)) throw new Error('Report path must be absolute');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-two-principal-prototype-'));
  const children = [];
  const checks = [];
  function check(name, task) { return Promise.resolve().then(task).then(() => checks.push({ name, passed: true })); }
  async function createOwner(name) {
    const root = path.join(sandbox, name);
    await fs.mkdir(path.join(root, 'db'), { recursive: true });
    const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 120000);
    const lowScope = issueOwnerCredential(['openai:read'], Date.now() + 120000);
    const id = `${name}_resource`;
    const policy = { schemaVersion: 1, ownerId: name, credentials: [issued.record, lowScope.record] };
    await fs.writeFile(path.join(root, 'owner-policy.json'), JSON.stringify(policy), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ownerId: name,
      tenantId: `${name}_tenant`, workspaceId: `${name}_workspace`, resourceIds: [id] }), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'db', `${id}.json`), JSON.stringify({ id, revision: 1, value: `${name} fixture value` }), { mode: 0o600 });
    const child = fork(path.join(__dirname, 'runtime.cjs'), [root], { windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test' },
    });
    children.push(child);
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic += String(chunk).slice(0, 4096); });
    const messages = [];
    const waiters = [];
    child.on('message', message => {
      const index = waiters.findIndex(waiter => waiter.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else messages.push(message);
    });
    child.on('exit', code => { for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Prototype child exit ${code}: ${diagnostic}`)); });
    const wait = type => {
      const index = messages.findIndex(message => message.type === type);
      return index >= 0 ? Promise.resolve(messages.splice(index, 1)[0])
        : new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
    };
    const ready = await wait('ready');
    return { root, id, policy, issued, lowScope, child, wait, url: `http://127.0.0.1:${ready.port}` };
  }
  async function request(owner, route, options = {}, token = owner.issued.token) {
    return fetch(owner.url + route, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  }
  try {
    const a = await createOwner('owner_a');
    const b = await createOwner('owner_b');
    await check('each independent runtime lists only its server-owned resources', async () => {
      assert.deepEqual((await (await request(a, '/resources')).json()).ids, [a.id]);
      assert.deepEqual((await (await request(b, '/resources')).json()).ids, [b.id]);
    });
    await check('foreign valid bearer fails authentication in the other runtime', async () => {
      assert.equal((await request(a, `/resources/${a.id}`, {}, b.issued.token)).status, 401);
      assert.equal((await request(b, `/resources/${b.id}`, {}, a.issued.token)).status, 401);
    });
    await check('guessed valid foreign resource IDs fail before data access', async () => {
      for (const kind of ['resources', 'background', 'stream']) {
        assert.equal((await request(a, `/${kind}/${b.id}`, { method: kind === 'background' ? 'POST' : 'GET' })).status, 404);
        assert.equal((await request(b, `/${kind}/${a.id}`, { method: kind === 'background' ? 'POST' : 'GET' })).status, 404);
      }
      assert.equal((await request(a, `/resources/${b.id}`, { method: 'PATCH', body: '{"value":"foreign"}', headers: { 'if-match': '1' } })).status, 404);
    });
    await check('forged identity/header/workspace claims do not change the principal', async () => {
      const response = await request(a, '/resources', { headers: { 'x-owner-id': 'owner_b', 'x-tenant-id': 'owner_b_tenant' } });
      assert.equal((await response.json()).actor, 'owner_a');
      assert.equal((await request(a, '/resources?workspace=owner_b_workspace')).status, 404);
      assert.equal((await request(a, '/resources', { headers: { 'x-flujo-workspace': 'owner_b_workspace' } })).status, 404);
      assert.equal((await request(a, '/resources?workspace=owner_a_workspace', { headers: { 'x-flujo-workspace': 'owner_b_workspace' } })).status, 404);
    });
    await check('scope-limited credential cannot obtain control resource access', async () => {
      assert.equal((await request(a, '/resources', {}, a.lowScope.token)).status, 403);
    });
    await check('missing bearer and corrupt or mismatched private policy fail closed without affecting the other owner', async () => {
      assert.equal((await fetch(a.url + '/resources')).status, 401);
      const policyPath = path.join(a.root, 'owner-policy.json');
      try {
        await fs.writeFile(policyPath, '{broken', { mode: 0o600 });
        assert.equal((await request(a, '/resources')).status, 503);
        await fs.writeFile(policyPath, JSON.stringify({ ...a.policy, ownerId: 'owner_b' }), { mode: 0o600 });
        assert.equal((await request(a, '/resources')).status, 503);
        assert.equal((await request(b, '/resources')).status, 200);
      } finally { await fs.writeFile(policyPath, JSON.stringify(a.policy), { mode: 0o600 }); }
      assert.equal((await request(a, '/resources')).status, 200);
    });
    await check('concurrent edits with the same revision yield one update and one visible conflict', async () => {
      const responses = await Promise.all(['first', 'second'].map(value => request(a, `/resources/${a.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'if-match': '1' }, body: JSON.stringify({ value }),
      })));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      assert.equal((await (await request(a, `/resources/${a.id}`)).json()).revision, 2);
      assert.equal((await (await request(b, `/resources/${b.id}`)).json()).revision, 1);
    });
    await check('concurrent background callbacks retain the immutable initiating principal', async () => {
      const accepted = await Promise.all([a, b].map(async owner => ({ owner,
        job: await (await request(owner, `/background/${owner.id}`, { method: 'POST' })).json() })));
      const results = accepted.map(({ owner, job }) => {
        const result = owner.wait('job-result'); owner.child.send({ type: 'release', jobId: job.jobId }); return result;
      });
      const observed = await Promise.all(results);
      assert.deepEqual(observed.map(message => message.result.actor), ['owner_a', 'owner_b']);
      assert.deepEqual(observed.map(message => message.result.workspaceId), ['owner_a_workspace', 'owner_b_workspace']);
      assert.ok(observed.every(message => message.result.status === 'observed'));
    });
    await check('revocation fences accepted background work and closes its existing stream', async () => {
      const job = await (await request(a, `/background/${a.id}`, { method: 'POST' })).json();
      const response = await request(a, `/stream/${a.id}`);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = await reader.read(); assert.equal(first.done, false);
      assert.match(Buffer.from(first.value).toString('utf8'), /owner_a/);
      a.policy.credentials[0].revokedAt = Date.now();
      const temporary = path.join(a.root, `policy.${randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(a.policy), { mode: 0o600 });
      await fs.rename(temporary, path.join(a.root, 'owner-policy.json'));
      const result = a.wait('job-result'); a.child.send({ type: 'release', jobId: job.jobId });
      assert.equal((await result).result.status, 'revoked');
      let deadline;
      const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Revoked stream did not close')), 3000); });
      const eof = (async () => {
        while (!(await reader.read()).done) { /* Await actual server EOF under the deadline. */ }
        return true;
      })();
      try { assert.equal(await Promise.race([eof, timeout]), true); }
      finally { clearTimeout(deadline); await reader.cancel(); }
      assert.equal((await request(a, '/resources')).status, 401);
      assert.equal((await request(b, '/resources')).status, 200);
    });
    const source = await fs.readFile(path.resolve(__dirname, '../../src/backend/services/security/ownerCredentials.ts'));
    const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      securityBase: '2c02fd0d3e4c36e702537a2e67bdd3d240101533', securityVerifierSha256: createHash('sha256').update(source).digest('hex'),
      node: process.version, platform: process.platform, checks, passed: true, evidenceClass: 'disposable source ownership prototype',
      actualAppRoutesVerified: false, productionIsolationVerified: false, designAccepted: false,
      limitations: ['two fixture HTTP runtimes; not installed FLUJO', 'separate OS processes are not hostile-code/host filesystem isolation',
        'no actual flow/provider/tool/approval/export/backup implementation verified', 'no browser identity provider/session/key lifecycle verified',
        'background callback is controlled IPC, not durable schedule/worker restart recovery', 'source bearer remains in the fixture Request; production stream witnesses must use Security recheck contract'] };
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ passed: true, checks: checks.length, evidenceClass: report.evidenceClass, ...(reportPath ? { report: reportPath } : {}) }) + '\n');
    return report;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.send({ type: 'stop' });
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    const absolute = path.resolve(sandbox);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('flujo-two-principal-prototype-')) {
      throw new Error('Refusing unexpected prototype cleanup path');
    }
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
run().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
