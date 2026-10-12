import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REFERENCE_DEFINITION_SHA256, REFERENCE_VERSION, REFERENCE_TOOLS, referenceJson, referenceJsonSha256,
} from './reference-data.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const cases = {
  'inbox-triage': {
    calls: [['product_fit_inbox', 'weekly']],
    answer: { ids: ['notice-02', 'notice-05'] },
  },
  'document-check': {
    calls: [['product_fit_document', 'overview'], ['product_fit_document', 'deployment']],
    answer: { differences: [{ field: 'minimumNodeMajor', overview: 22, deployment: 20 }] },
  },
  'page-compare': {
    calls: [['product_fit_page', 'catalog'], ['product_fit_page', 'status']],
    answer: { ids: ['green-kit'] },
  },
};

function requireValue(condition) {
  if (!condition) throw new Error('Invalid reference packet; submitted values are withheld.');
}
function keys(value, expected) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
const count = value => Number.isSafeInteger(value) && value >= 0;

export function checkReferenceResult(packet) {
  keys(packet, ['schemaVersion', 'workflow', 'fixtureReceipt', 'toolResults', 'answer']);
  requireValue(packet.schemaVersion === 1 && Object.hasOwn(cases, packet.workflow));
  const scenario = cases[packet.workflow];
  const receipt = packet.fixtureReceipt;
  keys(receipt, ['schemaVersion', 'synthetic', 'fixtureVersion', 'runId', 'definitionSha256',
    'toolCalls', 'acceptedCalls', 'rejectedCalls', 'byTool', 'retainedCallLimit', 'droppedCalls', 'recentCalls', 'claims']);
  requireValue(receipt.schemaVersion === 1 && receipt.synthetic === true && receipt.fixtureVersion === REFERENCE_VERSION &&
    UUID.test(receipt.runId) && receipt.definitionSha256 === REFERENCE_DEFINITION_SHA256);
  requireValue([receipt.toolCalls, receipt.acceptedCalls, receipt.rejectedCalls, receipt.droppedCalls].every(count) &&
    receipt.acceptedCalls + receipt.rejectedCalls === receipt.toolCalls && receipt.retainedCallLimit === 64);
  keys(receipt.byTool, REFERENCE_TOOLS.map(tool => tool.name));
  requireValue(Object.values(receipt.byTool).every(count) &&
    Object.values(receipt.byTool).reduce((sum, value) => sum + value, 0) === receipt.acceptedCalls);
  keys(receipt.claims, ['installedFlujo', 'modelReply', 'humanObservation', 'recurringBenefit']);
  requireValue(Object.values(receipt.claims).every(value => value === false));
  requireValue(Array.isArray(receipt.recentCalls) && receipt.recentCalls.length === Math.min(receipt.toolCalls, 64) &&
    receipt.droppedCalls === receipt.toolCalls - receipt.recentCalls.length);
  const retainedByTool = Object.fromEntries(REFERENCE_TOOLS.map(tool => [tool.name, 0]));
  let retainedRejected = 0;
  for (const [index, call] of receipt.recentCalls.entries()) {
    keys(call, ['sequence', 'observedAt', 'tool', 'accepted', 'errorCode', 'argumentsSha256', 'resultSha256', 'receiptPhraseSha256']);
    requireValue(call.sequence === receipt.droppedCalls + index + 1 && typeof call.observedAt === 'string' &&
      Number.isFinite(Date.parse(call.observedAt)) && new Date(call.observedAt).toISOString() === call.observedAt &&
      typeof call.accepted === 'boolean' && DIGEST.test(call.resultSha256));
    requireValue(call.accepted ? receipt.byTool[call.tool] > 0 && call.errorCode === null &&
      DIGEST.test(call.argumentsSha256) && DIGEST.test(call.receiptPhraseSha256) :
      (call.errorCode === 'unknown-tool' ? call.tool === 'unknown' :
        call.errorCode === 'invalid-arguments' && Object.hasOwn(receipt.byTool, call.tool)) &&
      call.argumentsSha256 === null && call.receiptPhraseSha256 === null);
    if (call.accepted) retainedByTool[call.tool] += 1;
    else retainedRejected += 1;
  }
  requireValue(Object.entries(retainedByTool).every(([tool, total]) => receipt.byTool[tool] >= total) &&
    receipt.rejectedCalls >= retainedRejected);
  requireValue(Array.isArray(packet.toolResults) && packet.toolResults.length === scenario.calls.length);
  const seen = new Set();
  const phrases = [];
  for (const result of packet.toolResults) {
    keys(result, ['synthetic', 'runId', 'definitionSha256', 'tool', 'selection', 'sequence', 'receiptPhrase', 'value']);
    requireValue(result.synthetic === true && result.runId === receipt.runId &&
      result.definitionSha256 === receipt.definitionSha256 &&
      scenario.calls.some(([tool, selection]) => tool === result.tool && selection === result.selection) &&
      !seen.has(`${result.tool}:${result.selection}`) && typeof result.receiptPhrase === 'string' &&
      result.receiptPhrase.startsWith('reference-') && UUID.test(result.receiptPhrase.slice(10)));
    seen.add(`${result.tool}:${result.selection}`);
    const call = receipt.recentCalls.find(candidate => candidate.sequence === result.sequence);
    const definition = REFERENCE_TOOLS.find(tool => tool.name === result.tool);
    const args = { [definition.inputSchema.required[0]]: result.selection };
    requireValue(call?.accepted === true && call.tool === result.tool && call.argumentsSha256 === referenceJsonSha256(args) &&
      call.resultSha256 === referenceJsonSha256(result) && call.receiptPhraseSha256 === hash(result.receiptPhrase));
    phrases.push(result.receiptPhrase);
  }
  keys(packet.answer, [...Object.keys(scenario.answer), 'receiptPhrases']);
  requireValue(Array.isArray(packet.answer.receiptPhrases) && packet.answer.receiptPhrases.length <= 2 &&
    packet.answer.receiptPhrases.every(phrase => typeof phrase === 'string' && phrase.length <= 64));
  const answer = { ...packet.answer };
  delete answer.receiptPhrases;
  const checks = {
    answerMatches: referenceJson(answer) === referenceJson(scenario.answer),
    receiptsMatch: JSON.stringify([...packet.answer.receiptPhrases].sort()) === JSON.stringify(phrases.sort()),
  };
  return {
    schemaVersion: 1, scope: 'synthetic-result-consistency', workflow: packet.workflow,
    result: Object.values(checks).every(Boolean) ? 'pass' : 'fail', checks,
    fixtureRunId: receipt.runId, definitionSha256: receipt.definitionSha256, joinedToolResults: phrases.length,
    claims: { installedFlujo: false, modelOriginVerified: false, humanObservation: false, recurringBenefit: false },
  };
}

async function readPacket(path) {
  const file = await open(path, 'r');
  try {
    requireValue((await file.stat()).isFile());
    const bytes = Buffer.alloc(32 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    requireValue(length <= 32 * 1024);
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/product-fit-pilot/reference-check.mjs <private-reference-packet.json>\n');
    return;
  }
  requireValue(args.length === 1 && !args[0].startsWith('--'));
  const bytes = await readPacket(args[0]);
  let packet;
  try { packet = JSON.parse(bytes.toString('utf8')); } catch { requireValue(false); }
  const report = checkReferenceResult(packet);
  const checker = await readFile(new URL('./reference-check.mjs', import.meta.url));
  const data = await readFile(new URL('./reference-data.mjs', import.meta.url));
  process.stdout.write(`${JSON.stringify({ ...report, inputSha256: hash(bytes),
    toolSha256: { checker: hash(checker), data: hash(data) } }, null, 2)}\n`);
  if (report.result === 'fail') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Reference packet could not be checked; check its format, 32 KiB limit and file access. Submitted values are withheld.\n');
    process.exitCode = 2;
  });
}
