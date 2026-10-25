'use strict';
// Finite source-boundary controls. No server, providers, modules resets or GC.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { NextRequest } = require('next/server');
const root = path.resolve(__dirname, '../..');
const predecessor = 'e3fae1217f2644307a002bfc9dcf328cf4c496f7';
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)
  || !path.relative(root, output).startsWith('..')) throw new Error('Supply a new absolute evidence directory outside the checkout.');
fs.mkdirSync(output, { recursive: true });
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceHashes = {};
const cache = new Map();
const logger = { debug() {}, info() {}, warn() {}, error() {}, verbose() {} };
function evaluate(source, key) {
  sourceHashes[key] = sha256(source);
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const load = name => {
    // Both revisions use the same inert unrelated metadata validators; cases
    // contain no Persona, tools or MCP metadata. Admission/parser code is real.
    if (name === '@/utils/logger') return { createLogger: () => logger };
    if (name === '@/shared/types/enduringAgent') return {};
    if (name === '@/backend/mcpApps/modelContext') return { parseMcpAppModelContexts: () => ({}) };
    if (name === '@/backend/services/mcp/skillModelContext') return { parseMcpSkillSelections: () => ({}) };
    if (name === '@/shared/types/openai') return { requireFunctionTools() {}, requireFunctionToolCalls() {} };
    if (name.startsWith('@/')) return current(`src/${name.slice(2)}.ts`);
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(load, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
function current(relative) {
  if (!cache.has(relative)) cache.set(relative, evaluate(fs.readFileSync(path.join(root, relative), 'utf8'), relative));
  return cache.get(relative);
}
const old = relative => execFileSync('git', ['show', `${predecessor}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
const parserPath = 'src/app/v1/chat/completions/requestParser.ts';
const baseline = evaluate(old(parserPath), `predecessor:${parserPath}`).parseRequestParameters;
const guarded = current(parserPath).parseRequestParameters;
const url = 'http://localhost/v1/chat/completions';
async function compare(name, body) {
  const request = () => new NextRequest(url, { method: 'POST', body });
  let currentStatus;
  try { await guarded(request()); currentStatus = 'accepted'; } catch (error) { currentStatus = error.code; }
  const parsed = await baseline(request());
  if (!parsed || currentStatus !== 'CHAT_INPUT_TOO_LARGE') throw new Error(`Unexpected equipment outcome for ${name}`);
  return { name, rawBytes: Buffer.byteLength(body), inputHash: sha256(body), guarded: currentStatus,
    predecessor: 'accepted; declared allocation boundary FAILED', expectedControlFailure: true };
}
(async () => {
  const cases = [];
  cases.push(await compare('raw bytes', JSON.stringify({ model: 'flow-fixture', messages: [{ role: 'user', content: 'a'.repeat(9 * 1024 * 1024) }] })));
  cases.push(await compare('depth', '{"model":"flow-fixture","messages":[],"extra":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'));
  cases.push(await compare('values', '{"model":"flow-fixture","messages":[],"extra":[' + '0,'.repeat(100_001) + '0]}'));
  const route = old('src/app/v1/chat/completions/route.ts');
  const start = route.indexOf('// Rate limiting - simple implementation');
  const end = route.indexOf('// Handle both GET and POST', start);
  if (start < 0 || end < 0) throw new Error('Frozen predecessor rate block not found.');
  const original = evaluate('const log = {debug(){},info(){},warn(){}};\n' + route.slice(start, end)
    + '\nexports.check = checkRateLimit; exports.size = () => requestCounts.size;', 'predecessor:rate-block');
  const rate = current('src/utils/http/chatRateLimit.ts');
  let refusals = 0;
  const now = Date.now();
  for (let index = 1; index <= 4097; index++) {
    const ip = `2001:db8::${index.toString(16)}`;
    original.check(ip);
    if (rate.checkChatRateLimit(ip, now) === 'capacity') refusals++;
  }
  if (original.size() !== 4097 || refusals !== 1 || rate.getChatRateDiagnostics().keys !== 4096) throw new Error('Unexpected rate-control outcome.');
  cases.push({ name: 'unique IP cardinality', guardedKeys: 4096, capacityRefusals: refusals,
    predecessorKeys: original.size(), predecessor: '4096-key boundary FAILED', expectedControlFailure: true });
  const receipt = { profile: 'chat-ingress-source-controls-v1', predecessor,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceHashes, node: process.version, cases, memory: process.memoryUsage(),
    drained: current('src/utils/http/chatIngress.ts').getChatIngressDiagnostics(),
    scope: 'Actual frozen/current parser and IP source; inert unrelated metadata helpers. No full HTTP server, SDK or endurance claim.', success: true };
  if (receipt.drained.active || receipt.drained.reservedBytes) throw new Error('Input reservations did not drain.');
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
