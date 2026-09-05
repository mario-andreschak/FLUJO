'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

async function createFixture(directory, retryDelayMs = 10_000) {
  await fs.mkdir(directory, { recursive: true });
  const nonce = randomBytes(6).toString('hex');
  const facts = {
    product: 'FLUJO',
    sourceId: `research-${nonce}`,
    audience: `independent automation teams ${nonce}`,
    benefit: `coordinate durable marketing work with evidence ${nonce}`,
    channel: 'developer community',
    nonce,
  };
  const state = { facts, retryDelayMs, publishAttempts: 0, retryAfter: null, published: null };
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(state, null, 2));
  await fs.writeFile(path.join(directory, 'audit.jsonl'), '');
  await fs.writeFile(path.join(directory, 'README.md'), 'The research client is not installed. Run node install-research-client.cjs in the terminal, then retry research_page. This installs a local fixture client, not an OS browser.');
  await fs.writeFile(path.join(directory, 'install-research-client.cjs'), "require('node:fs').writeFileSync('research-client.cjs', 'process.stdout.write(JSON.stringify(require(\"./state.json\").facts))'); console.log('Installed local research client');");
  return facts;
}

async function readFixture(directory) {
  return JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
}

const tools = [
  { name: 'terminal', description: 'Bounded terminal in the isolated fixture directory. Supported commands: ls, cat README.md, node install-research-client.cjs, node research-client.cjs. Use it to inspect and repair the local research client dependency. Node commands execute actual child processes. This fixture does not install a system browser.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } },
  { name: 'research_page', description: 'Read the controlled research page for the FLUJO campaign, including its source ID and facts. This is a local acceptance fixture, not the public internet.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'write_artifact', description: 'Write research.md or launch.md. Include the exact source ID, audience and benefit from research_page. At most one artifact should be authored per Activity; report progress and continue in the next Activity.', inputSchema: { type: 'object', properties: { name: { type: 'string', enum: ['research.md', 'launch.md'] }, content: { type: 'string', minLength: 40 } }, required: ['name', 'content'], additionalProperties: false } },
  { name: 'read_artifacts', description: 'Inspect existing research.md and launch.md artifacts and the actual controlled publication state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'publish_campaign', description: 'Publish the verified launch artifact to the local controlled external service. Idempotent after success. A temporary service outage may require a later Activity; retry without asking the user.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

async function readArtifacts(directory) {
  const result = {};
  for (const name of ['research.md', 'launch.md']) {
    try { result[name] = await fs.readFile(path.join(directory, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

function verifyContent(content, facts) {
  return typeof content === 'string' && content.length >= 80
    && [facts.sourceId, facts.audience, facts.benefit].every(value => content.includes(value));
}

async function callFixtureTool(directory, name, args = {}) {
  const state = await readFixture(directory);
  let result;
  if (name === 'terminal') {
    if (args.command === 'ls') result = text({ files: await fs.readdir(directory) });
    else if (args.command === 'cat README.md') result = text({ stdout: await fs.readFile(path.join(directory, 'README.md'), 'utf8') });
    else if (['node install-research-client.cjs', 'node research-client.cjs'].includes(args.command)) {
      try {
        const output = await execute(process.execPath, [args.command.split(' ')[1]], { cwd: directory, timeout: 10_000, windowsHide: true });
        result = text(output);
      } catch (error) { result = { ...text({ error: error.message }), isError: true }; }
    } else result = { ...text({ error: 'Unsupported fixture command. Inspect available files using ls and cat README.md.' }), isError: true };
  } else if (name === 'research_page') {
    try {
      const output = await execute(process.execPath, ['research-client.cjs'], { cwd: directory, timeout: 10_000, windowsHide: true });
      result = text({ url: `fixture://research/${state.facts.sourceId}`, ...JSON.parse(output.stdout) });
    } catch {
      result = { ...text({ error: 'Research client is unavailable. The terminal can inspect local setup instructions and install it. Resolve this environment dependency autonomously.' }), isError: true };
    }
  } else if (name === 'read_artifacts') {
    result = text({ artifacts: await readArtifacts(directory), published: state.published });
  } else if (name === 'write_artifact') {
    if (!['research.md', 'launch.md'].includes(args.name) || !verifyContent(args.content, state.facts)) {
      result = { ...text({ error: 'Artifact must use an allowed filename and cite the exact source ID, audience and benefit from the research page.' }), isError: true };
    } else {
      await fs.writeFile(path.join(directory, args.name), args.content);
      result = text({ written: args.name, sha256: hash(args.content), verified: true });
    }
  } else if (name === 'publish_campaign') {
    state.publishAttempts += 1;
    const artifacts = await readArtifacts(directory);
    if (!Object.values(artifacts).every(content => verifyContent(content, state.facts)) || Object.keys(artifacts).length !== 2) {
      result = { ...text({ error: 'Both verified research.md and launch.md artifacts are required before publication.' }), isError: true };
    } else if (!state.retryAfter) {
      state.retryAfter = Date.now() + state.retryDelayMs;
      result = { ...text({ error: 'Service temporarily unavailable', retryable: true, retryAfter: state.retryAfter, instruction: 'Preserve progress and retry in a later Activity. No user input is needed.' }), isError: true };
    } else if (Date.now() < state.retryAfter) {
      result = { ...text({ error: 'Service still temporarily unavailable', retryable: true, retryAfter: state.retryAfter }), isError: true };
    } else {
      state.published ??= { id: `publication-${state.facts.nonce}`, sourceId: state.facts.sourceId, sha256: hash(artifacts['launch.md']), content: artifacts['launch.md'], publishedAt: Date.now() };
      result = text({ published: state.published });
    }
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(state, null, 2));
  } else {
    throw new Error(`Unknown fixture tool: ${name}`);
  }
  await fs.appendFile(path.join(directory, 'audit.jsonl'), `${JSON.stringify({ at: Date.now(), name, argumentsHash: hash(JSON.stringify(args)), result })}\n`);
  return result;
}

async function verifyFixture(directory) {
  const state = await readFixture(directory);
  const artifacts = await readArtifacts(directory);
  const audit = (await fs.readFile(path.join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    facts: state.facts,
    artifacts: Object.entries(artifacts).map(([name, content]) => ({ name, sha256: hash(content), verified: verifyContent(content, state.facts), content })),
    publicationVerified: Boolean(state.published && state.published.sourceId === state.facts.sourceId && state.published.sha256 === hash(artifacts['launch.md'] ?? '') && verifyContent(state.published.content, state.facts)),
    published: state.published,
    transientFailureObserved: audit.some(event => event.name === 'publish_campaign' && event.result.isError === true && JSON.parse(event.result.content[0].text).retryable === true),
    environmentBootstrapVerified: audit.some(event => event.name === 'research_page' && event.result.isError === true)
      && audit.some(event => event.name === 'terminal' && !event.result.isError)
      && audit.some(event => event.name === 'research_page' && !event.result.isError),
    publishAttempts: state.publishAttempts,
    audit,
  };
}

module.exports = { createFixture, readFixture, readArtifacts, callFixtureTool, verifyFixture, tools };
