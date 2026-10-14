import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function sourceInputs(application) {
  const names = execFileSync('git', ['ls-files', '-z', '--', 'src', 'public', 'mcp-servers', 'packages', 'bin', 'tooling',
    'scripts', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'tsconfig.build.json', 'postcss.config.mjs'],
  { cwd: application, encoding: 'utf8' }).split('\0').filter(name => name
    && name !== 'scripts/smoke-operations-recovery.mjs' && !name.startsWith('scripts/operations-acceptance/')).sort();
  const members = [];
  for (const name of names) members.push({ name, sha256: sha256(await fs.readFile(path.join(application, name))) });
  return { files: members.length, sha256: sha256(JSON.stringify(members)) };
}
export async function builtInputs(application) {
  const members = [];
  const root = path.join(application, '.next');
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (['cache', 'dev', 'trace', 'trace-build', 'types', 'diagnostics'].includes(name)) continue;
      assert.ok(!entry.isSymbolicLink(), 'Linked build bytes cannot qualify this source profile.');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else if (entry.isFile()) members.push({ name, sha256: sha256(await fs.readFile(path.join(directory, entry.name))) });
    }
  }
  await visit(root);
  for (const name of ['shared', 'filesystem', 'bash', 'browser', 'flujo']) {
    await visit(path.join(application, 'mcp-servers', name, 'dist'), `mcp-servers/${name}/dist`);
  }
  assert.ok(members.some(member => member.name === 'BUILD_ID') && members.some(member => member.name.startsWith('server/')));
  return { files: members.length, sha256: sha256(JSON.stringify(members)) };
}
export async function verifyBuildEvidence(application, filename) {
  assert.ok(path.isAbsolute(filename), 'Build evidence must have an absolute path.');
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 256 * 1024, 'Invalid build evidence file.');
  const bytes = await fs.readFile(filename);
  const evidence = JSON.parse(bytes);
  assert.equal(evidence.schemaVersion, 1); assert.equal(evidence.kind, 'source-application-build');
  assert.equal(evidence.outcome, 'passed'); assert.match(evidence.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(await fs.realpath(evidence.application), await fs.realpath(application));
  assert.deepEqual(await sourceInputs(application), evidence.sourceInputs, 'Application inputs changed after the recorded build.');
  assert.deepEqual(await builtInputs(application), evidence.builtInputs, 'Emitted application bytes changed after the recorded build.');
  assert.equal((await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim(), evidence.buildId);
  return { ...evidence, evidenceSha256: sha256(bytes) };
}

// Reproducible local build admission; this does not qualify a released artifact.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === '--report' && path.isAbsolute(args[1]),
    'Usage: node scripts/operations-acceptance/build-evidence.mjs --report <new-absolute-build-receipt>');
  const application = fileURLToPath(new URL('../../', import.meta.url));
  const report = path.resolve(args[1]);
  await assert.rejects(fs.access(report), { code: 'ENOENT' });
  const manifest = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.build,
    'npm run build:mcp && node --require ./scripts/exclude-workspaces-from-next-glob.cjs node_modules/next/dist/bin/next build --webpack',
    'Inspect and admit a changed build command before using this source-only equipment.');
  for (const name of ['shared', 'filesystem', 'bash', 'browser', 'flujo']) {
    const workspace = JSON.parse(await fs.readFile(path.join(application, 'mcp-servers', name, 'package.json'), 'utf8'));
    assert.ok(workspace.scripts.build.startsWith('tsc ') && !/docker|podman|buildah|workflow/i.test(workspace.scripts.build),
      'Inspect the workspace build before using this source-only equipment.');
  }
  const npmPaths = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let npm;
  for (const candidate of npmPaths) { try { await fs.access(candidate); npm = candidate; break; } catch { /* try the next installed npm */ } }
  assert.ok(npm, 'Run through the installed npm runtime or supply its existing npm_execpath.');
  const before = await sourceInputs(application);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: application, encoding: 'utf8' }).trim();
  const startedAt = new Date().toISOString(), start = performance.now();
  const logPath = `${report}.log`, log = await fs.open(logPath, 'wx', 0o600);
  const command = [npm, 'run', 'build'];
  let code;
  try {
    const child = spawn(process.execPath, command, { cwd: application, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { await log.close(); }
  assert.equal(code, 0, `Application build failed; inspect ${logPath}.`);
  const after = await sourceInputs(application);
  assert.deepEqual(after, before, 'Application inputs changed during the build.');
  const evidence = { schemaVersion: 1, kind: 'source-application-build', outcome: 'passed', sourceRevision, application,
    startedAt, completedAt: new Date().toISOString(), seconds: (performance.now() - start) / 1000,
    sourceInputs: after, builtInputs: await builtInputs(application),
    buildId: (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim(), command,
    logSha256: sha256(await fs.readFile(logPath)) };
  await fs.writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcome: 'passed', buildId: evidence.buildId, seconds: evidence.seconds, report }));
}
