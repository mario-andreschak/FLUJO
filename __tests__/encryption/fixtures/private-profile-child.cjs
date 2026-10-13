// Disposable source-process probe, never an installed-runtime acceptance claim.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.argv[3]);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith('@/') ? path.join(process.argv[2], 'src', request.slice(2)) : request, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const lines = require('node:readline').createInterface({ input: process.stdin })[Symbol.asyncIterator]();
(async () => {
  const input = JSON.parse((await lines.next()).value);
  const format = require(path.join(process.argv[2], 'src/utils/encryption/format.ts'));
  const secure = require(path.join(process.argv[2], 'src/utils/encryption/secure.ts'));
  if (input.operation === 'mint') {
    const wrap = format.wrapKeyring;
    format.wrapKeyring = async (...args) => {
      const metadata = await wrap(...args);
      process.stdout.write('READY_TO_COMMIT\n');
      if ((await lines.next()).value !== 'commit') throw new Error('Fixture commit barrier failed');
      return metadata;
    };
    const ciphertext = await secure.encryptWithPassword(input.value);
    process.stdout.write(`${JSON.stringify({ ciphertext })}\n`);
  } else {
    const { runWithWorkspace } = require(path.join(process.argv[2], 'src/utils/workspace.ts'));
    const values = await runWithWorkspace(input.workspace, () => Promise.all(input.ciphertexts.map(value => secure.decryptWithPassword(value))));
    process.stdout.write(`${JSON.stringify({ recovered: values.every((value, index) => value === input.expected[index]) })}\n`);
  }
  process.stdin.destroy();
})().catch(() => { process.stderr.write('Private profile source probe failed.\n'); process.exitCode = 1; process.stdin.destroy(); });
