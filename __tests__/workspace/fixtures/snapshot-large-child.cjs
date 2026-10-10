// Disposable source-process probe, never an installed-runtime acceptance claim.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.argv[3]);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('mcp-stdio-oauth/')) {
    const root = path.join(process.argv[2], 'node_modules', 'mcp-stdio-oauth');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const target = manifest.exports['./' + request.slice('mcp-stdio-oauth/'.length)]?.import;
    if (target) return resolve.call(this, path.join(root, target), ...rest);
  }
  return resolve.call(this, request.startsWith('@/') ? path.join(process.argv[2], 'src', request.slice(2)) : request, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { promises: fsp, createReadStream } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { tmpdir } = require('node:os');
(async () => {
  // Source transpilation emits require; retain genuine import-only Tasks
  // namespaces through Node's native loader before loading the source graph.
  const nativeTasks = new Map(await Promise.all([
    '@modelcontextprotocol/ext-tasks/core',
    '@modelcontextprotocol/ext-tasks/core/v2',
    '@modelcontextprotocol/ext-tasks/client',
  ].map(async name => [name, await import(name)])));
  const load = Module._load;
  Module._load = function loadNativeTasks(request, parent, isMain) {
    return nativeTasks.has(request) ? nativeTasks.get(request) : load.call(this, request, parent, isMain);
  };
  const root = await fsp.mkdtemp(path.join(tmpdir(), 'flujo-large-snapshot-'));
  let captured, archive;
  let peakRss = 0;
  const observe = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
  try {
    process.env.FLUJO_DATA_DIR = path.join(root, 'source');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
    delete process.env.FLUJO_SNAPSHOT_MAX_BYTES;
    delete process.env.FLUJO_SNAPSHOT_MAX_FILE_BYTES;
    const key = randomBytes(32).toString('base64');
    const source = path.join(process.env.FLUJO_DATA_DIR, 'workspaces', 'research', 'userdata');
    await fsp.mkdir(source, { recursive: true });
    const expected = [];
    let state = 0x12345678;
    for (let member = 0; member < 3; member++) {
      const handle = await fsp.open(path.join(source, `${member}.bin`), 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        for (let size = 0; size < 140 * 1024 * 1024; size += 64 * 1024) {
          const chunk = Buffer.alloc(64 * 1024);
          for (let offset = 0; offset < chunk.length; offset += 4) {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            chunk.writeUInt32LE(state >>> 0, offset);
          }
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      expected.push(hash.digest('hex'));
    }
    const archiveModule = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotArchive.ts'));
    const { withWorkspaceRecoveryCapture } = require(path.join(process.argv[2], 'src/backend/services/workspace/workspaceMutationGate.ts'));
    captured = await withWorkspaceRecoveryCapture(generation => archiveModule.captureWorkspaceSnapshot('research', generation, { recipientKey: key }), { workspace: 'research', timeoutMs: 60000 });
    process.stdout.write('CAPTURED\n');
    // Prove later source writes cannot alter the captured generation.
    await fsp.writeFile(path.join(source, '0.bin'), Buffer.from('later generation'));
    archive = await archiveModule.writeWorkspaceSnapshotArchive(captured);
    if (archive.size <= require('node:buffer').constants.MAX_STRING_LENGTH) throw new Error('Fixture did not cross the original string limit.');
    process.stdout.write('WRITTEN\n');
    const { openSnapshotDownload } = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotStreaming.ts'));
    const download = await openSnapshotDownload(archive.archivePath, archive.size, archive.sha256, new AbortController().signal, () => {});
    const downloaded = path.join(root, 'download');
    const output = await fsp.open(downloaded, 'wx', 0o600);
    try {
      const reader = download.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await output.writeFile(next.value);
      }
      await output.sync();
    } finally { await output.close(); }
    process.stdout.write('DOWNLOADED\n');
    await captured.dispose(); captured = undefined;
    process.env.FLUJO_DATA_DIR = path.join(root, 'target');
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_WORKER_SNAPSHOT = downloaded;
    process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = archive.sha256;
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = key;
    const { restoreConfiguredWorkerSnapshot } = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotRestore.ts'));
    await restoreConfiguredWorkerSnapshot();
    for (let member = 0; member < 3; member++) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path.join(process.env.FLUJO_DATA_DIR, 'workspaces', 'research', 'userdata', `${member}.bin`))) hash.update(chunk);
      if (hash.digest('hex') !== expected[member]) throw new Error('Restored member hash mismatch.');
    }
    process.stdout.write(JSON.stringify({ restored: 3, wireBytes: archive.size, peakRss }) + '\n');
  } finally {
    clearInterval(observe);
    await captured?.dispose?.();
    if (archive) await fsp.rm(archive.stagingDir, { recursive: true, force: true });
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
