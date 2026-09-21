import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tracer = require.resolve('next/dist/compiled/@vercel/nft');
const preload = fileURLToPath(new URL('./exclude-workspaces-from-next-glob.cjs', import.meta.url));
const child = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const workspaceRoot = path.join(process.cwd(), 'workspaces');
  let reads = 0;
  let tracing = true;
  for (const [object, method] of [[fs, 'readdir'], [fs, 'readdirSync'], [fs.promises, 'readdir']]) {
    const original = object[method];
    object[method] = function(candidate, ...args) {
      const relative = path.relative(workspaceRoot, String(candidate));
      if (tracing && (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))) reads++;
      return original.call(this, candidate, ...args);
    };
  }
  require(process.argv[1]);
  const { nodeFileTrace } = require(process.argv[2]);
  nodeFileTrace(['entry.cjs'], { base: process.cwd(), processCwd: process.cwd() }).then(async result => {
    tracing = false;
    console.log(JSON.stringify({
      reads,
      files: [...result.fileList].map(file => file.replaceAll('\\', '/')),
      ordinarySync: fs.readdirSync(workspaceRoot),
      ordinaryAsync: await fs.promises.readdir(workspaceRoot),
    }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const pattern of ['dynamic project-wide glob', 'direct workspace glob']) {
  test(`Next tracer prunes runtime data before traversing a ${pattern}`, (t) => {
    const tempRoot = path.resolve(tmpdir());
    const root = mkdtempSync(path.join(tempRoot, 'flujo-next-trace-test-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(root)), tempRoot);
      assert.ok(path.basename(root).startsWith('flujo-next-trace-test-'));
      rmSync(root, { recursive: true, force: true });
    });
    function write(relative, content) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    write('workspaces/default/mcp-servers/private.json', '{"runtime":"private"}');
    write('shipped/mcp-servers/asset.json', '{"shipped":true}');
    write('workspaces-backup/mcp-servers/asset.json', '{"prefixCollision":true}');
    write('assets/template.txt', 'Required application asset');
    write('dependency.cjs', 'module.exports = 42;');
    const directory = pattern.startsWith('dynamic')
      ? "path.join(process.cwd(), process.env.DYNAMIC_DIRECTORY, 'mcp-servers')"
      : "path.join(process.cwd(), 'workspaces', 'default', 'mcp-servers')";
    write('entry.cjs', `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.readdirSync(${directory});
      fs.readFileSync(path.join(${directory}, process.env.DYNAMIC_FILE));
      fs.readFileSync(path.join(__dirname, 'assets', 'template.txt'));
      require('./dependency.cjs');
    `);
    const result = spawnSync(process.execPath, ['-e', child, preload, tracer], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.reads, 0, 'The tracer must not enumerate runtime data, even before final trace exclusions');
    assert.ok(report.files.includes('dependency.cjs'));
    assert.ok(report.files.includes('assets/template.txt'));
    assert.ok(!report.files.some(file => file.startsWith('workspaces/')));
    if (pattern.startsWith('dynamic')) {
      assert.ok(report.files.includes('shipped/mcp-servers/asset.json'));
      assert.ok(report.files.includes('workspaces-backup/mcp-servers/asset.json'));
    }
    assert.deepEqual(report.ordinarySync, ['default'], 'Application filesystem access remains unchanged');
    assert.deepEqual(report.ordinaryAsync, ['default']);
  });
}
