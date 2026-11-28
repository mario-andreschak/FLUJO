#!/usr/bin/env node
// Runs inside the FLUJO image during the container smoke (#1408); scripts/smoke-container-image.mjs
// starts it with `docker exec`. It talks to the app on 127.0.0.1:4200 like a client in the same
// container, answers every model and tool request with a local stand-in and prints one result line.
//
//   first-chat  a stand-in OpenAI-compatible model answers a first chat through a flow (streamed and
//               not) and a direct model call, with the settings a new install has
//   voice       the voice-app check that used to need a real Claude token on a 1-vCPU machine:
//               a Claude subscription model (the bundled Claude Code, talking to a stand-in of
//               Anthropic's API) and one MCP tool, first with the three speed settings off, then on
//   verify      after a hard stop and restart: every finished turn is still stored and both
//               models still answer
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { STUB_MODEL_ID, STUB_TEST_REPLY, startStubModel } from '../first-journey/stub-model.mjs';
import {
  ANSWERS, CLASSIFY_INSTRUCTION, ORDER_TOOL, TOOL_MARKER, startClaudeStandIn, startMcpStandIn,
} from './stand-ins.mjs';

/** Fixed ports inside the container; the Claude one is ANTHROPIC_BASE_URL of the container. */
export const STAND_IN_PORTS = Object.freeze({ openai: 4310, anthropic: 4311, mcp: 4312 });
export const RESULT_PREFIX = 'FLUJO_CONTAINER_SMOKE ';
export const TRACE_FILE = '/tmp/flujo-turn-trace.jsonl';
export const PLACEHOLDER_TOKEN = 'sk-ant-oat01-container-smoke-stand-in-not-a-token';
export const SPEED_SETTINGS = Object.freeze(['claudeWarmProcess', 'mcpListCache', 'lowLatencySaves']);
const APP = process.env.FLUJO_SMOKE_APP_URL ?? 'http://127.0.0.1:4200';
const RUNS = 4;
// Like a caller speaking between turns; a prepared Claude process has time to start.
const PAUSE_MS = 2_500;
const MODELS = Object.freeze({ openai: 'smoke-openai', claude: 'smoke-claude' });
const FLOWS = Object.freeze({ chat: 'SmokeChat', voice: 'SmokeVoice' });

export const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
};

async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(route, APP), {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : undefined;
}

async function ready() {
  const body = await api('/api/init');
  if (body?.success !== true) throw new Error('GET /api/init did not report a finished start-up.');
}

const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
  sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });

/** start -> process -> finish, with the stand-in MCP server bound to the process node when given. */
export function smokeFlow({ id, name, model, server }) {
  const nodes = [
    node('start', 'start', { promptTemplate: 'You are the voice assistant of a small shop. Keep answers short.' }),
    node('process', 'process', { boundModel: model, inputMode: 'full-history', allowQuestion: false,
      promptTemplate: 'Answer the caller in one or two sentences. Use a tool when you need order data.' }),
    node('finish', 'finish'),
    ...(server ? [node('tools', 'mcp', { boundServer: server, enabledTools: [ORDER_TOOL], enabledResources: 'all' })] : []),
  ];
  const edges = [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2]),
    ...(server ? [{ id: 'tools-process', source: 'tools', target: 'process', type: 'custom', data: { edgeType: 'mcp' } }] : [])];
  return { id, name, nodes, edges, updatedAt: Date.now() };
}

/** Read a streamed or plain chat completion; a failed run is an error, never an answer. */
async function chat(body) {
  const sent = performance.now();
  const response = await fetch(new URL('/v1/chat/completions', APP), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  if (!body.stream || !response.ok) {
    const text = await response.text();
    if (!response.ok) throw new Error(`Chat with ${body.model} answered ${response.status}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text);
    return { sent, end: performance.now(), content: parsed.choices?.[0]?.message?.content ?? '', conversationId: parsed.conversation_id };
  }
  let content = '';
  let firstContent;
  let conversationId;
  let failed = false;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
      const line = buffer.slice(0, index).split('\n').find((item) => item.startsWith('data: '));
      buffer = buffer.slice(index + 2);
      if (!line || line === 'data: [DONE]') continue;
      const parsed = JSON.parse(line.slice(6));
      if (parsed.error) throw new Error(`Chat with ${body.model} streamed an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === 'error') failed = true;
      if (choice?.delta?.content) { firstContent ??= performance.now(); content += choice.delta.content; }
      conversationId ??= choice?.delta?.conversation?.conversationId;
    }
  }
  if (failed) throw new Error(`Chat with ${body.model} ended with an error: ${content.slice(0, 400)}`);
  return { sent, end: performance.now(), firstContent, content, conversationId };
}

function expectAnswer(result, expected, what) {
  if (!result.content.includes(expected)) throw new Error(`${what} answered "${result.content.slice(0, 200)}", expected "${expected}".`);
}

/** The text of every stored message of a conversation, in order. */
async function storedTexts(conversationId) {
  const conversation = await api(`/v1/chat/conversations/${encodeURIComponent(conversationId)}`);
  return (conversation.messages ?? []).filter((message) => ['user', 'assistant'].includes(message.role))
    .map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`);
}

/** Every finished turn of the conversation is stored: its question and its answer, in order. */
export function assertTurnsStored(texts, turns, label) {
  let position = 0;
  for (const [index, turn] of turns.entries()) {
    const question = texts.findIndex((text, at) => at >= position && text.startsWith('user:') && text.includes(turn.question));
    const answer = texts.findIndex((text, at) => at > question && text.startsWith('assistant:') && text.includes(turn.answer));
    if (question < 0 || answer < 0) {
      throw new Error(`${label}: turn ${index + 1} of ${turns.length} is not stored (question ${question >= 0}, answer ${answer >= 0}).`);
    }
    position = answer + 1;
  }
}

/** Speed settings are switched the way a user does it: in the stored Settings. */
async function setSpeedSettings(on) {
  const current = (await api('/api/storage?key=speech_settings'))?.value ?? {};
  const experimental = { ...(current.experimental ?? {}) };
  for (const name of SPEED_SETTINGS) experimental[name] = on;
  await api('/api/storage', { key: 'speech_settings', value: { ...current, experimental } });
  // The flow engine and the MCP client re-read these settings at most once a second.
  await delay(1_200);
}

/** Bundled Claude Code processes alive in this container. */
export async function claudeProcesses(procRoot = '/proc') {
  let count = 0;
  for (const name of await readdir(procRoot).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const command = await readFile(path.join(procRoot, name, 'cmdline'), 'utf8').catch(() => '');
    if (/claude-agent-sdk[^\0]*[\\/]claude(?:\.exe)?(?:\0|$)/.test(command)) count++;
  }
  return count;
}

async function waitForClaudeProcesses(accept, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const count = await claudeProcesses();
    if (accept(count) || Date.now() >= until) return count;
    await delay(200);
  }
}

let traceLines = 0;
/** The step timer lines FLUJO wrote for the requests since the last call. */
async function newTraceLines() {
  const until = Date.now() + 3_000;
  for (;;) {
    const lines = (await readFile(TRACE_FILE, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (lines.length > traceLines || Date.now() >= until) {
      const fresh = lines.slice(traceLines).map((line) => JSON.parse(line));
      traceLines = lines.length;
      return fresh;
    }
    await delay(50);
  }
}

const spanCount = (lines, name) => lines.reduce((sum, line) => sum + (line.spans ?? []).filter((span) => span.name === name).length, 0);

async function firstChat() {
  const stub = await startStubModel({ port: STAND_IN_PORTS.openai });
  try {
    await ready();
    await api('/api/model', { id: MODELS.openai, name: STUB_MODEL_ID, displayName: MODELS.openai, provider: 'openai', adapter: 'openai',
      ApiKey: 'stand-in-key-not-a-secret', baseUrl: stub.url });
    await api('/api/flow', smokeFlow({ id: 'smoke-chat-flow', name: FLOWS.chat, model: MODELS.openai }));
    const question = 'Hello! What can you do?';
    const streamed = await chat({ model: `flow-${FLOWS.chat}`, stream: true, messages: [{ id: randomUUID(), role: 'user', content: question }] });
    expectAnswer(streamed, STUB_TEST_REPLY, 'The streamed first chat');
    const plain = await chat({ model: `flow-${FLOWS.chat}`, stream: false, messages: [{ id: randomUUID(), role: 'user', content: question }] });
    expectAnswer(plain, STUB_TEST_REPLY, 'The first chat');
    if (!plain.conversationId) throw new Error('The first chat returned no conversation id.');
    assertTurnsStored(await storedTexts(plain.conversationId), [{ question, answer: STUB_TEST_REPLY }], 'The first chat');
    const direct = await chat({ model: `model-${MODELS.openai}`, stream: false, messages: [{ role: 'user', content: question }] });
    expectAnswer(direct, STUB_TEST_REPLY, 'The direct model call');
    return {
      checks: ['streamed flow chat answered', 'flow chat answered and stored', 'direct model call answered'],
      conversations: [{ id: plain.conversationId, turns: [{ question, answer: STUB_TEST_REPLY }] }],
      timings: { streamedMs: Math.round(streamed.end - streamed.sent), plainMs: Math.round(plain.end - plain.sent), directMs: Math.round(direct.end - direct.sent) },
      modelRequests: stub.events.filter((event) => event.kind === 'completion').length,
    };
  } finally {
    await stub.close();
  }
}

const QUESTIONS = Object.freeze({
  direct: 'Where is my order A-1? It should ship today.',
  tool: `${TOOL_MARKER} Where is my order A-1?`,
  continue: 'When does store 3 open?',
});
const EXPECTED = Object.freeze({ direct: ANSWERS.classify, tool: ANSWERS.tool, continue: ANSWERS.plain });

async function voiceTurn(scenario, standIns, conversation) {
  const before = { model: standIns.claude.requests.length, mcp: standIns.mcp.methods.length };
  const question = QUESTIONS[scenario];
  const result = await chat(scenario === 'direct'
    ? { model: `model-${MODELS.claude}`, stream: false, messages: [
      { role: 'system', content: `Classify the caller message. ${CLASSIFY_INSTRUCTION}` }, { role: 'user', content: question }] }
    : { model: `flow-${FLOWS.voice}`, stream: scenario === 'tool', messages: [{ id: randomUUID(), role: 'user', content: question }],
      ...(scenario === 'continue' ? { metadata: { flujo: 'true', ...(conversation.id ? { conversationId: conversation.id, appendMessages: 'true' } : {}) } } : {}) });
  expectAnswer(result, EXPECTED[scenario], `The ${scenario} turn`);
  const modelRequests = standIns.claude.requests.slice(before.model);
  if (!modelRequests.length || modelRequests.some((request) => !request.oauth)) {
    throw new Error(`The ${scenario} turn did not reach the stand-in through Claude Code with the subscription token.`);
  }
  const methods = standIns.mcp.methods.slice(before.mcp);
  if (scenario === 'tool' && !methods.includes('tools/call')) throw new Error('The tool turn never called the MCP tool.');
  if (scenario === 'continue') {
    conversation.id ??= result.conversationId;
    conversation.turns.push({ question, answer: EXPECTED[scenario] });
  }
  const trace = await newTraceLines();
  const marks = trace.flatMap((line) => (line.marks ?? []).map((mark) => mark.name));
  const ms = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10);
  return {
    totalMs: ms(result.end - result.sent),
    beforeModelMs: ms(modelRequests[0].arrival - result.sent),
    firstTextMs: ms(result.firstContent === undefined ? undefined : result.firstContent - result.sent),
    modelRequests: modelRequests.length,
    mcpLists: methods.filter((method) => method.endsWith('/list')).length,
    saves: spanCount(trace, 'persist.snapshot'),
    // FLUJO's step timer marks a request that took a Claude Code process prepared before it.
    claimed: marks.includes('claude.claimed'),
    ...(marks.some((name) => name.startsWith('claude.spareMiss:'))
      ? { spareMiss: marks.find((name) => name.startsWith('claude.spareMiss:')).slice('claude.spareMiss:'.length) } : {}),
  };
}

/** One series of turns per scenario with the speed settings off or on. */
async function voiceSeries(on, standIns) {
  await setSpeedSettings(on);
  const series = { on, scenarios: {} };
  const continued = { id: undefined, turns: [] };
  for (const scenario of ['direct', 'tool', 'continue']) {
    const runs = [];
    for (let run = 1; run <= RUNS; run++) {
      if (run > 1) await delay(PAUSE_MS);
      runs.push(await voiceTurn(scenario, standIns, continued));
    }
    // With the setting on, a Claude Code process waits for the next request; with it off none stays.
    const parked = await waitForClaudeProcesses((count) => (on ? count > 0 : count === 0), 15_000);
    series.scenarios[scenario] = { runs, parkedAfter: parked };
  }
  assertTurnsStored(await storedTexts(continued.id), continued.turns, `The continued conversation (settings ${on ? 'on' : 'off'})`);
  series.conversation = { id: continued.id, turns: continued.turns };
  return series;
}

const warm = (series, scenario, key) => median(series.scenarios[scenario].runs.slice(1).map((run) => run[key]));

/**
 * What the three settings must change, from what FLUJO and the stand-ins observed (never from
 * timings, which a busy machine scatters): a Claude Code process waits ready and the next request
 * of the same shape takes it, MCP lists are reused, and a turn saves fewer times. A ready process
 * may miss now and then by design (it is refused or too slow, and FLUJO starts one as before), so
 * two of the three later runs must take one.
 */
export function assertSpeedSettingsWork(off, on) {
  const problems = [];
  for (const [scenario, { parkedAfter }] of Object.entries(off.scenarios)) {
    if (parkedAfter !== 0) problems.push(`with the settings off, ${parkedAfter} Claude Code processes stayed after the ${scenario} turns`);
  }
  const offClaims = Object.values(off.scenarios).flatMap((scenario) => scenario.runs).filter((run) => run.claimed).length;
  if (offClaims) problems.push(`with the settings off, ${offClaims} requests took a prepared Claude Code process`);
  if (on.scenarios.direct.parkedAfter < 1) problems.push('with the settings on, no Claude Code process waited for the next request');
  // A turn that resumes a stored Claude session starts its own process (#1408, part 1), and a
  // continued conversation always resumes its session (#1449).
  for (const scenario of ['direct', 'tool']) {
    const later = on.scenarios[scenario].runs.slice(1);
    const claimed = later.filter((run) => run.claimed).length;
    if (claimed < later.length - 1) {
      const misses = [...new Set(later.map((run) => run.spareMiss).filter(Boolean))];
      problems.push(`only ${claimed} of ${later.length} later ${scenario} requests took a prepared Claude Code process${misses.length ? ` (differing: ${misses.join(', ')})` : ''}`);
    }
  }
  const listsOff = warm(off, 'tool', 'mcpLists');
  const listsOn = warm(on, 'tool', 'mcpLists');
  if (!(listsOn < listsOff)) problems.push(`MCP lists were not reused (${listsOn} vs ${listsOff} list requests per tool turn)`);
  for (const scenario of ['tool', 'continue']) {
    const savesOff = warm(off, scenario, 'saves');
    const savesOn = warm(on, scenario, 'saves');
    if (!(savesOn < savesOff)) problems.push(`the ${scenario} turn did not save fewer times (${savesOn} vs ${savesOff} conversation saves)`);
  }
  if (problems.length) throw new Error(`The speed settings did not take effect: ${problems.join('; ')}.`);
}

async function voice() {
  const claude = await startClaudeStandIn({ port: STAND_IN_PORTS.anthropic });
  const mcp = await startMcpStandIn({ port: STAND_IN_PORTS.mcp });
  try {
    await ready();
    await api('/api/model', { id: MODELS.claude, name: 'haiku', displayName: MODELS.claude, provider: 'claude-subscription', adapter: 'claude-cli',
      ApiKey: PLACEHOLDER_TOKEN });
    await api('/api/mcp/servers', { name: 'smoke', transport: 'streamable', serverUrl: mcp.url, disabled: false });
    await api('/api/flow', smokeFlow({ id: 'smoke-voice-flow', name: FLOWS.voice, model: MODELS.claude, server: 'smoke' }));
    await newTraceLines();
    const off = await voiceSeries(false, { claude, mcp });
    const on = await voiceSeries(true, { claude, mcp });
    assertSpeedSettingsWork(off, on);
    return {
      checks: ['Claude subscription model answered through the bundled Claude Code', 'one MCP tool call per tool turn',
        'continued conversations stored every turn', 'speed settings took effect'],
      series: { off, on },
      conversations: [off.conversation, on.conversation],
    };
  } finally {
    await claude.close();
    await mcp.close();
  }
}

async function verify(state) {
  const stub = await startStubModel({ port: STAND_IN_PORTS.openai });
  const claude = await startClaudeStandIn({ port: STAND_IN_PORTS.anthropic });
  try {
    await ready();
    for (const conversation of state.conversations ?? []) {
      assertTurnsStored(await storedTexts(conversation.id), conversation.turns, `Conversation ${conversation.id} after the restart`);
    }
    const plain = await chat({ model: `model-${MODELS.openai}`, stream: false, messages: [{ role: 'user', content: 'Still there?' }] });
    expectAnswer(plain, STUB_TEST_REPLY, 'The direct model call after the restart');
    const claudeTurn = await chat({ model: `model-${MODELS.claude}`, stream: false, messages: [
      { role: 'system', content: `Classify the caller message. ${CLASSIFY_INSTRUCTION}` }, { role: 'user', content: QUESTIONS.direct }] });
    expectAnswer(claudeTurn, ANSWERS.classify, 'The Claude subscription call after the restart');
    return { checks: [`${(state.conversations ?? []).length} conversations kept every finished turn`, 'both models answer after the restart'] };
  } finally {
    await stub.close();
    await claude.close();
  }
}

const PHASES = Object.freeze({ 'first-chat': firstChat, voice, verify });

export async function main(argv = process.argv.slice(2)) {
  const [phase, stateJson] = argv;
  if (!Object.hasOwn(PHASES, phase ?? '')) throw new Error(`Usage: node scripts/container-smoke/inside.mjs ${Object.keys(PHASES).join('|')} [state JSON]`);
  const started = performance.now();
  const result = await PHASES[phase](stateJson ? JSON.parse(stateJson) : {});
  return { phase, node: process.version, seconds: Math.round((performance.now() - started) / 100) / 10, ...result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => { console.log(`${RESULT_PREFIX}${JSON.stringify({ ok: true, ...result })}`); },
    (error) => { console.log(`${RESULT_PREFIX}${JSON.stringify({ ok: false, error: error.message })}`); process.exitCode = 1; },
  );
}
