// Disposable source-process continuity probe, not an installed application.
const fs = require('node:fs');
const ts = require(process.argv[3]);
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(compiled.outputText, filename);
};
const { resolveOwnerRequest } = require(process.argv[2]);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const origin = new URL(process.env.FLUJO_OWNER_BROWSER_ORIGIN);
const result = resolveOwnerRequest(new Request(`${origin.origin}/api/models`, {
  headers: { host: origin.host, origin: origin.origin, cookie: input.cookie },
}), undefined, { now: input.now });
process.stdout.write(String(result.ok ? 200 : result.response.status));
