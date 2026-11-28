#!/usr/bin/env node
/**
 * Run the official MCP conformance tool (server mode) against a running FLUJO
 * endpoint, for example the Flows endpoint or one exposed server's proxy:
 *
 *   npm run conformance:mcp -- --url http://localhost:4200/mcp-flows
 *   npm run conformance:mcp -- --url http://localhost:4200/mcp-proxy/<server> --scenario server-stateless
 *
 * The tool is the publisher's own npm package, pinned in devDependencies
 * (@modelcontextprotocol/conformance, MIT); its client scenarios run in
 * __tests__/mcp/mcpClientConformance.test.ts. Only its pre-release line has the
 * 2026-07-28 scenarios. Results go to a folder outside the repository.
 * The exit code is non-zero when any scenario failed.
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const conformanceCli = path.join(path.dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/conformance/package.json')), 'dist', 'index.js');
const DEFAULT_SCENARIOS = ['server-stateless', 'http-header-validation', 'dns-rebinding-protection', 'tools-list'];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const url = option('url');
if (!url) {
  console.error('Usage: npm run conformance:mcp -- --url <FLUJO MCP endpoint> [--scenario a,b] [--out <folder>]');
  process.exit(2);
}
const scenarios = option('scenario')?.split(',').map(value => value.trim()).filter(Boolean) ?? DEFAULT_SCENARIOS;
const out = option('out') ?? await mkdtemp(path.join(os.tmpdir(), 'flujo-mcp-conformance-'));

function run(scenario) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,
      [conformanceCli, 'server', '--url', url, '--scenario', scenario, '--output-dir', out],
      { stdio: 'inherit' });
    child.on('close', code => resolve({ scenario, code: code ?? 1 }));
    child.on('error', () => resolve({ scenario, code: 1 }));
  });
}

const results = [];
for (const scenario of scenarios) results.push(await run(scenario));
console.log(`\nMCP conformance against ${url} (results in ${out}):`);
for (const { scenario, code } of results) console.log(`  ${code === 0 ? 'passed' : 'failed'}  ${scenario}`);
process.exit(results.some(result => result.code !== 0) ? 1 : 0);
