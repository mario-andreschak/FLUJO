// MCP checks against FLUJO as shipped (the installed npm package and the installed
// checkout the Windows and shell installers leave behind). A local program server runs
// over standard input and output. A server behind OAuth signs in against
// scripts/mcp-oauth-reference-server.mjs (built from the official MCP SDK's server-side
// sign-in handlers): FLUJO's own routes start the sign-in, a headless request follows the
// consent redirect back to FLUJO, an expired token is refreshed, the sign-in survives a
// restart, and resetting it revokes the grant at the provider. No person clicks anything.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MCP_CHECKS = Object.freeze({
  'mcp-stdio': 'A local program (stdio) MCP server starts and its tool answers',
  'mcp-oauth': 'An MCP server behind OAuth signs in through the browser redirect, and an expired token is refreshed without a new sign-in',
  'mcp-oauth-after-restart': 'After a restart the MCP sign-in still works and refreshes with no new consent; resetting it revokes the grant',
});

const STDIO_NAME = 'Packaged stdio check';
const OAUTH_NAME = 'Packaged OAuth check';
const TOOL_DEADLINE_MS = 60_000;

/**
 * A dependency-free MCP server on standard input and output with one tool, "echo". One
 * line without double quotes or shell operators, so it passes unchanged through
 * `node -e` on every system.
 */
export const STDIO_SERVER_SOURCE = [
  "function send(m){process.stdout.write(JSON.stringify(m)+'\\n')}",
  "const known=['2025-11-25','2025-06-18','2025-03-26'];",
  "require('node:readline').createInterface({input:process.stdin}).on('line',function(line){",
  'let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;',
  "function ok(result){send({jsonrpc:'2.0',id:m.id,result:result})}",
  "if(m.method==='initialize')return ok({protocolVersion:known.includes(m.params?.protocolVersion)?m.params.protocolVersion:known[1],",
  "capabilities:{tools:{}},serverInfo:{name:'packaged-stdio-check',version:'1.0.0'}});",
  "if(m.method==='ping')return ok({});",
  "if(m.method==='tools/list')return ok({tools:[{name:'echo',description:'Answers with the text it gets.',",
  "inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]});",
  "if(m.method==='tools/call')return ok({content:[{type:'text',text:String(m.params?.arguments?.text??'')}]});",
  "send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});});",
].join('');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const serverRoute = name => `/api/mcp/servers/${encodeURIComponent(name)}`;

async function call(request, route, body, { method = body === undefined ? 'GET' : 'POST', expect = [200] } = {}) {
  const response = await request(route, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try { data = JSON.parse(response.bytes.toString('utf8')); } catch { data = undefined; }
  if (!expect.includes(response.status)) {
    throw new Error(`${method} ${route} answered ${response.status}: ${response.bytes.toString('utf8').slice(0, 300)}`);
  }
  return data;
}

/** Call a tool until the connection is up (bounded); the answer's text. */
async function toolText(request, server, tool, args, deadlineMs = TOOL_DEADLINE_MS) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const result = await call(request, `${serverRoute(server)}/tools/${encodeURIComponent(tool)}`, { args }, { expect: [200, 400, 401, 403, 404, 408, 409, 500, 502, 503] });
    if (result?.success === true) {
      return (result.data?.content ?? []).map(item => item?.text ?? '').join('');
    }
    if (Date.now() >= until) throw new Error(`${server} did not answer ${tool}: ${JSON.stringify(result).slice(0, 300)}`);
    await pause(1_000);
  }
}

/** Start the reference servers as a child process that ends when this process does. */
export async function startReferenceServers({ moduleRoots, spawnProcess = spawn }) {
  const args = [path.join(root, 'scripts', 'mcp-oauth-reference-server.mjs'), ...moduleRoots.flatMap(dir => ['--module-root', dir])];
  const child = spawnProcess(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const addresses = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
    });
    child.once('exit', code => reject(new Error(`The MCP reference servers did not start (${code}): ${errors.trim()}`)));
  });
  return {
    ...addresses,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      await Promise.race([exited, pause(10_000).then(() => child.kill())]);
    },
  };
}

/** Follow the consent redirects like a browser until FLUJO's MCP page. */
export async function followConsent(authorizationUrl, appOrigin, fetchImpl = fetch) {
  let current = new URL(authorizationUrl);
  for (let hop = 0; hop < 10; hop++) {
    if (current.origin === appOrigin && current.pathname === '/mcp') return current;
    const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || !location) throw new Error(`${current.origin}${current.pathname} answered ${response.status} during sign-in.`);
    current = new URL(location, current);
  }
  throw new Error('The sign-in redirected more than ten times.');
}

export function createMcpChecks(reference, { fetchImpl = fetch } = {}) {
  const control = async (route, body) => {
    const response = await fetchImpl(`${reference.control}/${route}`, body === undefined
      ? { signal: AbortSignal.timeout(10_000) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`The reference server's ${route} answered ${response.status}.`);
    return response.json();
  };
  const count = async (kind, extra = {}) => (await control('log'))
    .filter(entry => entry.kind === kind && Object.entries(extra).every(([key, value]) => entry[key] === value)).length;

  return {
    async stdio(request) {
      await call(request, '/api/mcp/servers', {
        name: STDIO_NAME, transport: 'stdio', command: 'node', args: ['-e', STDIO_SERVER_SOURCE],
        env: {}, disabled: false, rootPath: '', _buildCommand: '', _installCommand: '',
      }, { expect: [201] });
      const text = await toolText(request, STDIO_NAME, 'echo', { text: 'packaged acceptance' });
      if (text !== 'packaged acceptance') throw new Error(`The stdio server answered "${text}".`);
      // Stop the program again, so only the app itself is left for the later stop checks.
      await call(request, serverRoute(STDIO_NAME), { disabled: true }, { method: 'PUT' });
      return { tool: 'echo' };
    },

    async oauth(request, appOrigin) {
      await call(request, '/api/encryption/secure', { action: 'initialize_default' });
      await call(request, '/api/mcp/servers', {
        name: OAUTH_NAME, transport: 'streamable', serverUrl: reference.resource, headers: {}, env: {},
        disabled: true, rootPath: '', _buildCommand: '', _installCommand: '',
      }, { expect: [201] });
      const started = await call(request, '/api/oauth/initiate', { serverName: OAUTH_NAME });
      if (typeof started?.authorizationUrl !== 'string') throw new Error(`Authenticate opened no sign-in page: ${JSON.stringify(started)}`);
      const authorization = new URL(started.authorizationUrl);
      if (authorization.searchParams.get('code_challenge_method') !== 'S256' || authorization.searchParams.get('resource') !== reference.resource) {
        throw new Error('The sign-in page was opened without S256 PKCE or without the resource indicator.');
      }
      const landing = await followConsent(authorization, appOrigin, fetchImpl);
      if (landing.searchParams.get('oauth_success') !== OAUTH_NAME) {
        throw new Error(`The sign-in ended with ${landing.searchParams.get('oauth_error') ?? 'no result'}: ${landing.searchParams.get('error_description') ?? ''}`);
      }
      await call(request, serverRoute(OAUTH_NAME), { disabled: false }, { method: 'PUT' });
      await toolText(request, OAUTH_NAME, 'read_note', {});
      const refreshes = await count('token', { grantType: 'refresh_token', outcome: 'issued' });
      await control('expire-access-tokens', {});
      await toolText(request, OAUTH_NAME, 'read_note', {});
      if (await count('token', { grantType: 'refresh_token', outcome: 'issued' }) <= refreshes) {
        throw new Error('The expired access token was not refreshed.');
      }
      return { registration: authorization.searchParams.get('client_id') === reference.clientMetadataUrl ? 'client ID metadata document' : 'dynamic' };
    },

    async oauthAfterRestart(request, restart) {
      const consents = await count('authorize');
      await restart();
      await toolText(request, OAUTH_NAME, 'read_note', {});
      await control('expire-access-tokens', {});
      await toolText(request, OAUTH_NAME, 'read_note', {});
      if (await count('authorize') !== consents) throw new Error('The restarted app asked for a new consent.');
      const reset = await call(request, '/api/oauth/reset', { serverName: OAUTH_NAME });
      const { grants } = await control('state');
      if (reset?.revokedAtProvider !== true || grants.some(grant => !grant.revoked)) {
        throw new Error('Resetting the sign-in did not revoke the grant at the provider.');
      }
      await call(request, serverRoute(OAUTH_NAME), { disabled: true }, { method: 'PUT' });
      return { revokedAtProvider: true };
    },
  };
}
