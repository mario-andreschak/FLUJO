// Offline Source restart probe; no provider network or installed-artifact claim.
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
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { authenticate } = require(path.join(process.argv[2], 'src/utils/encryption/secure.ts'));
  const { loadServerConfigs } = require(path.join(process.argv[2], 'src/backend/services/mcp/config.ts'));
  const { MCPOAuthClientProvider } = require(path.join(process.argv[2], 'src/backend/services/mcp/oauth.ts'));
  const configs = await loadServerConfigs();
  const config = configs.find(value => value.name === input.name);
  const provider = new MCPOAuthClientProvider(config, 'http://localhost:4200/api/oauth/callback');
  try { await provider.tokens(); throw new Error('Unexpected unlocked profile'); }
  catch (error) { if (!error.message.startsWith('Stored OAuth credentials are unavailable.')) throw error; }
  if (!await authenticate(input.passphrase)) throw new Error('Unlock failed');
  const tokens = await provider.tokens();
  const client = await provider.clientInformation();
  const verifier = await provider.codeVerifier();
  if (tokens.access_token !== input.access || tokens.refresh_token !== input.refresh
      || tokens.id_token !== input.identity || client.client_secret !== input.secret
      || verifier !== input.verifier) throw new Error('Credential mismatch');
  process.stdout.write('OAUTH_SOURCE_RESTART_PASS\n');
})().catch(() => { process.stderr.write('OAuth source restart probe failed.\n'); process.exitCode = 1; });
