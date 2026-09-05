'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fixture = require('./fixture.cjs');

async function readJsonLines(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function createFixture(directory, retryDelayMs = 10_000) {
  const browserDirectory = path.join(directory, 'browsers');
  let initialDirectoryExists = true;
  let initialEntries;
  try { initialEntries = await fs.readdir(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    initialDirectoryExists = false;
    initialEntries = [];
  }
  const observedAt = Date.now();
  if (initialEntries.length !== 0) throw new Error('Terminal-only acceptance requires an initially empty fixture directory.');
  const facts = await fixture.createFixture(directory, retryDelayMs);
  await fs.unlink(path.join(directory, 'install-research-client.cjs'));
  await fs.writeFile(path.join(directory, 'browser-audit.jsonl'), '');
  await fs.writeFile(path.join(directory, 'terminal-audit.jsonl'), '');
  await fs.writeFile(path.join(directory, 'http-audit.jsonl'), '');
  await fs.writeFile(path.join(directory, 'terminal-fixture.json'), JSON.stringify({
    schemaVersion: 2, initialDirectoryExists, initialEntries, observedAt,
    fixtureRoot: await fs.realpath(directory), browserDirectory,
  }));
  return facts;
}

async function startResearchServer(directory) {
  const { facts } = await fixture.readFixture(directory);
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const audit = { at: Date.now(), method: request.method, url: request.url, userAgent: request.headers['user-agent'] ?? '', body };
    await fs.appendFile(path.join(directory, 'http-audit.jsonl'), `${JSON.stringify(audit)}\n`);
    if (request.url === '/research') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><title>FLUJO campaign research</title><main><h1>FLUJO campaign evidence</h1><p id="source">Source: ${facts.sourceId}</p><p id="audience">Audience: ${facts.audience}</p><p id="benefit">Benefit: ${facts.benefit}</p><p>Channel: ${facts.channel}</p></main><script>fetch('/browser-observed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:${JSON.stringify(facts.sourceId)},rendered:document.querySelector('main').innerText})})</script></html>`);
    } else if (request.url === '/browser-observed') {
      response.setHeader('Content-Type', 'application/json'); response.end('{"observed":true}');
    } else if (request.url === '/publication' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify((await fixture.readFixture(directory)).published));
    } else if (request.url === '/publish' && request.method === 'POST') {
      const result = await fixture.callFixtureTool(directory, 'publish_campaign');
      response.statusCode = result.isError ? 503 : 200;
      response.setHeader('Content-Type', 'application/json'); response.end(result.content[0].text);
    } else {
      response.statusCode = 404; response.end('Use /research, POST /publish, or GET /publication.');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const readme = `# FLUJO local campaign environment\n\nThis is an isolated controlled acceptance workspace. Node and a general terminal are available. A browser and browser libraries are not installed here. Install any needed dependencies locally. PLAYWRIGHT_BROWSERS_PATH defaults to this workspace's browsers directory; any installation directory inside this workspace is allowed. Temporary files and dependency caches default to local directories too.\n\nResearch page: ${baseUrl}/research\nPublication: POST ${baseUrl}/publish; it validates research.md and launch.md in this directory and may temporarily fail. Inspect the actual published state with GET ${baseUrl}/publication.\n\nSuccess requires using a real headless Chromium browser to read the research page, writing research.md and launch.md that cite the exact source ID, audience and benefit, and publishing the launch artifact successfully. Each artifact should be useful prose, not a placeholder. Keep files and dependencies in this workspace; do not post to public services. Choose and execute your own commands, repair missing dependencies and recover from temporary errors without asking a supervisor.\n`;
  await fs.writeFile(path.join(directory, 'README.md'), readme);
  await fs.writeFile(path.join(directory, 'http-environment.json'), JSON.stringify({ baseUrl }));
  return server;
}

async function executeTerminal(directory, args) {
  const command = args.command;
  if (typeof command !== 'string' || !command.trim()) throw new Error('A non-empty command is required.');
  const timeoutMs = Math.max(1_000, Math.min(300_000, Number(args.timeoutMs) || 120_000));
  const startedAt = Date.now();
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
  const fixtureRoot = await fs.realpath(directory);
  const temporaryDirectory = path.join(fixtureRoot, '.tmp');
  const npmCache = path.join(fixtureRoot, '.npm-cache');
  const nodeCompileCache = path.join(fixtureRoot, '.node-compile-cache');
  const cacheDirectory = path.join(fixtureRoot, '.cache');
  await Promise.all([temporaryDirectory, npmCache, nodeCompileCache, cacheDirectory].map(localDirectory => fs.mkdir(localDirectory, { recursive: true })));
  const result = await new Promise(resolve => {
    const child = spawn(shell, shellArgs, {
      cwd: directory, windowsHide: true,
      env: { ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(directory, 'browsers'),
        FLUJO_GOAL_FIXTURE_ROOT: fixtureRoot,
        FLUJO_GOAL_BROWSER_AUDIT: path.join(directory, 'browser-audit.jsonl'),
        TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory,
        npm_config_cache: npmCache, NODE_COMPILE_CACHE: nodeCompileCache,
        XDG_CACHE_HOME: cacheDirectory,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="${path.resolve(__dirname, 'browser-observer.cjs').replace(/\\/g, '/')}"`.trim(),
      },
    });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-50_000); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-50_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill();
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ exitCode: 1, stdout, stderr: error.message, timedOut }); });
    child.once('exit', code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, timedOut }); });
  });
  await fs.appendFile(path.join(directory, 'terminal-audit.jsonl'), `${JSON.stringify({ at: startedAt, endedAt: Date.now(), command, ...result })}\n`);
  return { content: [{ type: 'text', text: JSON.stringify({ cwd: directory, shell, ...result }) }], ...(result.exitCode !== 0 || result.timedOut ? { isError: true } : {}) };
}

async function verifyFixture(directory) {
  const base = await fixture.verifyFixture(directory);
  const [browserLaunches, httpRequests, terminalCommands] = await Promise.all([
    readJsonLines(path.join(directory, 'browser-audit.jsonl')),
    readJsonLines(path.join(directory, 'http-audit.jsonl')),
    readJsonLines(path.join(directory, 'terminal-audit.jsonl')),
  ]);
  const setup = JSON.parse(await fs.readFile(path.join(directory, 'terminal-fixture.json'), 'utf8'));
  const canonicalFixtureRoot = await fs.realpath(directory);
  // Independently resolve the actual executable against our own root; observer
  // booleans or an agent-selected browser environment are not the boundary.
  const genuineLaunches = (await Promise.all(browserLaunches.map(async event => {
    if (event.type !== 'browser_spawn' || typeof event.executable !== 'string'
      || event.bytes <= 1_000_000 || !Number.isSafeInteger(event.pid) || event.pid <= 0) return null;
    try {
      const executable = await fs.realpath(event.executable);
      const relative = path.relative(canonicalFixtureRoot, executable);
      const stat = await fs.stat(executable);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative) && stat.isFile() && stat.size === event.bytes ? event : null;
    } catch { return null; }
  }))).filter(Boolean);
  const browserReads = httpRequests.filter(event => event.url === '/browser-observed' && /Chrome|Chromium/i.test(event.userAgent) && event.body.includes(base.facts.sourceId));
  const launchesWithBrowserReads = genuineLaunches.filter(launch => browserReads.some(request => request.at >= launch.at && request.at - launch.at < 120_000));
  const browserExecutionVerified = launchesWithBrowserReads.length > 0;
  return { ...base,
    environmentBootstrapVerified: setup.schemaVersion === 2 && Array.isArray(setup.initialEntries)
      && setup.initialEntries.length === 0 && setup.fixtureRoot === canonicalFixtureRoot
      && Number.isFinite(setup.observedAt) && launchesWithBrowserReads.some(launch => launch.at >= setup.observedAt)
      && browserExecutionVerified,
    browserExecutionVerified, environmentSetup: setup, browserLaunches, httpRequests, terminalCommands,
  };
}

module.exports = { createFixture, startResearchServer, executeTerminal, verifyFixture };
