import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { selfSignedCertificate } from './certificate.mjs';
import { SANDBOX_ADDRESS_PATH, SESSION_COOKIE, SIGN_IN_PATH, browserResponseHeaders, safeNext, startFrontDoor,
  upstreamRequestHeaders, withoutSessionCookie } from './proxy.mjs';
import { CHECKS, HOSTNAME, NAMES, agentFlow, frontDoorStartupLine, main, reachableThroughFrontDoor } from './run.mjs';

const certificate = selfSignedCertificate(HOSTNAME);

test('the certificate names the front door host and verifies with its own key', () => {
  const parsed = new X509Certificate(certificate.cert);
  assert.equal(parsed.subjectAltName, `DNS:${HOSTNAME}`);
  assert.equal(parsed.checkHost(HOSTNAME), HOSTNAME);
  assert.equal(parsed.checkPrivateKey(createPrivateKey(certificate.key)), true);
  assert.equal(parsed.verify(parsed.publicKey), true);
  assert.ok(new Date(parsed.validTo).getTime() > Date.now() + 86_400_000);
  assert.throws(() => selfSignedCertificate('bad host/name'), /not a host name/);
});

test('sign-in redirects only to paths on the front door itself', () => {
  assert.equal(safeNext('/chat?flow=a'), '/chat?flow=a');
  for (const value of ['//evil.test/x', '/\\evil.test', 'https://evil.test/', 'chat', undefined, '/a\r\nset-cookie: x']) assert.equal(safeNext(value), '/');
});

test('FLUJO never receives the front door cookie', () => {
  assert.equal(withoutSessionCookie(`${SESSION_COOKIE}=abc`), undefined);
  assert.equal(withoutSessionCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`), 'a=1; b=2');
  assert.equal(withoutSessionCookie(undefined), undefined);
});

test('FLUJO gets its loopback Host and Origin and learns the public address only for the sandbox address', () => {
  const browser = { host: 'flujo.test:8443', origin: 'https://flujo.test:8443', cookie: `${SESSION_COOKIE}=s; theme=dark`,
    'x-forwarded-host': 'evil.test', forwarded: 'for=1.2.3.4', connection: 'keep-alive', accept: 'application/json' };
  const plain = upstreamRequestHeaders(browser, { upstream: 'http://127.0.0.1:4200', publicOrigin: 'https://flujo.test:8443', pathname: '/api/flow' });
  assert.deepEqual(plain, { host: '127.0.0.1:4200', origin: 'http://127.0.0.1:4200', cookie: 'theme=dark', accept: 'application/json' });
  const sandboxAddress = upstreamRequestHeaders(browser, { upstream: 'http://127.0.0.1:4200', publicOrigin: 'https://flujo.test:8443', pathname: SANDBOX_ADDRESS_PATH });
  assert.equal(sandboxAddress['x-forwarded-host'], 'flujo.test:8443');
  assert.equal(sandboxAddress['x-forwarded-proto'], 'https');
  const sandboxPage = upstreamRequestHeaders(browser, { upstream: 'http://127.0.0.1:4201', pathname: '/sandbox.html', rewriteOrigin: false });
  assert.equal(sandboxPage.origin, 'https://flujo.test:8443');
  assert.equal(sandboxPage.host, '127.0.0.1:4201');
  assert.equal(sandboxPage['x-forwarded-host'], undefined);
});

test('FLUJO\'s own absolute redirects point back at the front door', () => {
  assert.equal(browserResponseHeaders({ location: 'http://127.0.0.1:4200/chat?x=1' }, { upstream: 'http://127.0.0.1:4200' }).location, '/chat?x=1');
  assert.equal(browserResponseHeaders({ location: 'https://elsewhere.test/' }, { upstream: 'http://127.0.0.1:4200' }).location, 'https://elsewhere.test/');
  assert.equal(browserResponseHeaders({ 'transfer-encoding': 'chunked', 'content-type': 'text/html' }, { upstream: 'http://127.0.0.1:4200' })['transfer-encoding'], undefined);
});

test('the startup line must name both front door addresses', () => {
  const addresses = { sandboxOrigin: 'https://flujo.test:2', dashboardOrigin: 'https://flujo.test:1' };
  const line = '[FLUJO] MCP Apps sandbox (localhost mode): requests through the front door use shared address https://flujo.test:2/sandbox.html '
    + 'and extra dashboard origins https://flujo.test:1; this computer keeps <app>.localhost.';
  assert.equal(frontDoorStartupLine(`before\n${line}\nafter`, addresses), line);
  assert.equal(frontDoorStartupLine(line.replace(':2/', ':3/'), addresses), undefined);
});

test('the check drives an agent whose app shows a view, through every stage', () => {
  const flow = agentFlow();
  assert.equal(flow.id, NAMES.flow);
  const tools = flow.nodes.find((node) => node.type === 'mcp');
  assert.deepEqual(tools.data.properties, { boundServer: NAMES.server, enabledTools: ['open_view'], enabledResources: 'all' });
  assert.equal(flow.nodes.find((node) => node.type === 'process').data.properties.boundModel, NAMES.model);
  assert.deepEqual(CHECKS.map((check) => check.id), ['startup-line', 'this-computer', 'sign-in', 'chat-app-view']);
});

test('the browser reaches only the front door, like a phone on another network', () => {
  const door = { dashboardOrigin: 'https://flujo.test:1', sandboxOrigin: 'https://flujo.test:2' };
  for (const reachable of ['https://flujo.test:1/chat', 'https://flujo.test:2/sandbox.html?x=1', 'data:text/plain,hi', 'blob:https://flujo.test:2/id']) {
    assert.equal(reachableThroughFrontDoor(new URL(reachable), door), true, reachable);
  }
  for (const blocked of ['http://127.0.0.1:4200/chat', 'http://app1.localhost:4201/sandbox.html', 'https://flujo.test:3/', 'http://flujo.test:1/']) {
    assert.equal(reachableThroughFrontDoor(new URL(blocked), door), false, blocked);
  }
});

test('--help prints the usage', async () => {
  const lines = [];
  assert.equal(await main(['--help'], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /npm run build/);
});

function listen(server) {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

function request(port, { method = 'GET', path = '/', headers = {}, body, host = `${HOSTNAME}:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({ host: '127.0.0.1', port, method, path, servername: HOSTNAME, ca: certificate.cert,
      headers: { host, ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('the front door requires the sign-in and forwards like the documented gateway', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ port: 'app', url: req.url, headers: req.headers });
    if (req.url === '/moved') { res.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/chat` }); res.end(); return; }
    res.end('from FLUJO');
  });
  const sandboxUpstream = http.createServer((req, res) => { seen.push({ port: 'sandbox', url: req.url, headers: req.headers }); res.end('sandbox page'); });
  const [appPort, sandboxPort] = [await listen(upstream), await listen(sandboxUpstream)];
  const door = await startFrontDoor({ hostname: HOSTNAME, password: 'correct horse', certificate });
  t.after(async () => {
    await door.close();
    for (const server of [upstream, sandboxUpstream]) await new Promise((resolve) => { server.close(resolve); });
  });
  const dashboard = Number(new URL(door.dashboardOrigin).port);
  const sandbox = Number(new URL(door.sandboxOrigin).port);

  assert.equal((await request(dashboard, { headers: { accept: 'text/html', cookie: `${SESSION_COOKIE}=guess` } })).status, 303);
  assert.equal((await request(dashboard, { path: '/api/flow' })).status, 401);
  assert.equal((await request(dashboard, { host: `evil.test:${dashboard}` })).status, 421);
  const page = await request(dashboard, { path: '/chat', headers: { accept: 'text/html' } });
  assert.equal(page.headers.location, `${SIGN_IN_PATH}?next=%2Fchat`);
  assert.match((await request(dashboard, { path: page.headers.location })).body, /<label for="password">Password<\/label>/);

  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const wrong = await request(dashboard, { method: 'POST', path: SIGN_IN_PATH, headers: form, body: 'password=nope&next=%2Fchat' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const signedIn = await request(dashboard, { method: 'POST', path: SIGN_IN_PATH, headers: form, body: 'password=correct+horse&next=%2Fchat' });
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, '/chat');
  const [cookie] = signedIn.headers['set-cookie'];
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=/$`));
  const session = cookie.split(';')[0];

  assert.equal((await request(dashboard, { path: '/chat', headers: { cookie: session } })).status, 502, 'nothing is forwarded before FLUJO is connected');
  door.connect({ upstream: `http://127.0.0.1:${appPort}/`, sandboxUpstream: `http://127.0.0.1:${sandboxPort}` });

  const answer = await request(dashboard, { method: 'POST', path: '/api/flow', body: '{}',
    headers: { cookie: `${session}; theme=dark`, origin: door.dashboardOrigin, 'x-forwarded-host': 'evil.test', 'content-type': 'application/json' } });
  assert.equal(answer.body, 'from FLUJO');
  const flow = seen.at(-1);
  assert.equal(flow.headers.host, `127.0.0.1:${appPort}`);
  assert.equal(flow.headers.origin, `http://127.0.0.1:${appPort}`);
  assert.equal(flow.headers.cookie, 'theme=dark');
  assert.equal(flow.headers['x-forwarded-host'], undefined);

  await request(dashboard, { path: `${SANDBOX_ADDRESS_PATH}?serverName=a`, headers: { cookie: session } });
  assert.equal(seen.at(-1).headers['x-forwarded-host'], `${HOSTNAME}:${dashboard}`);
  assert.equal(seen.at(-1).headers['x-forwarded-proto'], 'https');
  assert.equal(seen.at(-1).headers.cookie, undefined);
  assert.equal((await request(dashboard, { path: '/moved', headers: { cookie: session } })).headers.location, '/chat');

  assert.equal((await request(sandbox, { path: '/sandbox.html?token=t' })).status, 403);
  const framed = await request(sandbox, { path: '/sandbox.html?token=t', headers: { cookie: session, referer: `${door.dashboardOrigin}/chat` } });
  assert.equal(framed.body, 'sandbox page');
  const sandboxRequest = seen.at(-1);
  assert.equal(sandboxRequest.port, 'sandbox');
  assert.equal(sandboxRequest.url, '/sandbox.html?token=t');
  assert.equal(sandboxRequest.headers.host, `127.0.0.1:${sandboxPort}`);
  assert.equal(sandboxRequest.headers.referer, `${door.dashboardOrigin}/chat`);
  assert.equal(sandboxRequest.headers.cookie, undefined);
  assert.deepEqual({ signIns: door.stats.signIns, failedSignIns: door.stats.failedSignIns, sandboxAddressRequests: door.stats.sandboxAddressRequests },
    { signIns: 1, failedSignIns: 1, sandboxAddressRequests: 1 });
});
