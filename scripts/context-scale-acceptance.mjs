import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Opt-in real inference. Run through the approved local tool runner.
assert.equal(process.env.FLUJO_CONTEXT_SCALE_ACCEPTANCE, '1', 'Explicit live acceptance opt-in required');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.FLUJO_CONTEXT_SCALE_ROOT;
assert(root && path.isAbsolute(root), 'Private absolute receipt/profile root required');
assert(path.relative(repo, root).startsWith('..'), 'Acceptance data must remain outside the checkout');
await fs.mkdir(root, { recursive: true });
const buildDirectory = path.resolve(repo, process.env.FLUJO_ACCEPTANCE_DIST_DIR ?? '.next');
assert.equal(path.dirname(buildDirectory), repo);
assert(path.basename(buildDirectory).startsWith('.next'));
const primary = process.env.FLUJO_CONTEXT_SCALE_SOURCE_ROOT;
assert(primary && path.isAbsolute(primary), 'Existing FLUJO installation/data root required');
assert(path.relative(primary, root).startsWith('..'), 'Acceptance profiles must not share the source data root');
const mode = process.argv[2];
const reusedFixture = mode === 'images' && process.argv[3] === 'reuse'
  ? JSON.parse(await fs.readFile(path.join(root, 'live-images-receipt.json'), 'utf8')).fixture : undefined;
assert(['images', 'regions', 'long', 'free-long', 'free-resume', 'inspect', 'resume', 'recover', 'recall-replay', 'recall-holdout', 'recall-id-replay', 'crop-replay'].includes(mode));
const imageMode = mode === 'crop-replay' || mode === 'images' || mode === 'regions' || mode === 'free-long' || mode === 'free-resume';
const require = createRequire(path.join(repo, 'package.json'));
require('@next/env').loadEnvConfig(primary, false, { info() {}, error() {} });
process.env.FLUJO_DATA_DIR = primary;
process.env.FLUJO_PARENT_DATA_DIR = primary;
process.env.FLUJO_CODEX_AUTO_UPDATE = '0';
process.env.NEXT_TELEMETRY_DISABLED = '1';
const runtime = require(path.join(buildDirectory, 'server/webpack-runtime.js'));
require(path.join(buildDirectory, 'server/app/v1/chat/completions/route.js'));
async function load(marker) {
  const candidates = Object.entries(runtime.m).filter(([, body]) => body.toString().includes(marker));
  assert.equal(candidates.length, 1, 'Ambiguous module: ' + marker);
  return runtime(candidates[0][0]);
}
function select(exports, predicate) {
  const candidates = Object.values(exports).filter(predicate);
  assert.equal(candidates.length, 1);
  return candidates[0];
}
const modelService = select(await load('backend/services/model/index'), value => value && typeof value.loadModels === 'function');
const ModelHandler = select(await load('backend/flow/execution/handlers/ModelHandler'), value => typeof value?.callModel === 'function');
const FlowExecutor = select(await load('backend/execution/flow/FlowExecutor'), value => value?.conversationStates instanceof Map);
const persistConversationState = select(await load('backend/execution/flow/persistConversationState'), value => typeof value === 'function');
const models = await modelService.loadModels();
const freeSource = models.find(model => model.name === 'openrouter/free' && !model.fallbackPolicy);
const lunaSource = models.find(model => model.name === 'gpt-6-luna' && model.adapter === 'codex-cli' && !model.fallbackPolicy);
assert(freeSource && lunaSource, 'Existing approved Free and subscription Luna models required');
assert(!lunaSource.ApiKey?.trim(), 'Subscription model must not use an API key');
assert.equal(new URL(freeSource.baseUrl).origin, 'https://openrouter.ai');
if (mode === 'inspect') {
  console.log(JSON.stringify({ models: [freeSource, lunaSource].map(({ id, name, provider, adapter, contextWindow, maxTokens, inputModalities }) =>
    ({ id, name, provider, adapter, contextWindow, maxTokens, inputModalities })) }));
  process.exit(0);
}
const key = imageMode ? await modelService.resolveAndDecryptApiKey(freeSource.ApiKey) : undefined;
if (imageMode) assert(key && !key.startsWith('encrypted'), 'Existing Free credential must decrypt');
const profile = ['resume', 'recover', 'free-resume', 'recall-replay', 'recall-holdout', 'recall-id-replay', 'crop-replay'].includes(mode) ? process.argv[3] : path.join(root, 'live-' + mode + '-' + randomUUID());
assert(profile && path.resolve(profile).startsWith(path.resolve(root) + path.sep));
await fs.mkdir(profile, { recursive: true });
process.env.FLUJO_DATA_DIR = profile;
process.env.FLUJO_PARENT_DATA_DIR = profile;
const report = path.join(root, mode === 'recover' ? 'live-long-recovery-receipt.json' : 'live-' + mode + '-receipt.json');
const evidence = { mode, status: 'running', profile, startedUtc: new Date().toISOString(),
  buildId: (await fs.readFile(path.join(buildDirectory, 'BUILD_ID'), 'utf8')).trim(),
  limitations: ['Synthetic test content; actual built ModelHandler and real approved models',
    'Does not alone qualify browser paste, every provider, side-effect recovery or hours of endurance'], cases: [] };
const save = () => fs.writeFile(report, JSON.stringify(evidence, null, 2));
await save();
// Observation-only wrapper around the emitted production function. Arguments,
// results and retry behavior are unchanged; record logical completion calls.
const originalGenerate = ModelHandler.generateCompletion;
let previouslyArchivedSourceIds;
evidence.instrumentation = { kind: 'pass-through logical-completion observer',
  originalFunctionSha256: createHash('sha256').update(originalGenerate.toString()).digest('hex') };
evidence.completions = [];
ModelHandler.generateCompletion = async function (...args) {
  const entry = { modelId: args[0], inputCharacters: JSON.stringify(args[2]).length, startedUtc: new Date().toISOString() };
  const controls = args[2]?.at(-1);
  if (previouslyArchivedSourceIds && controls?.role === 'system'
    && controls.content?.startsWith('The source conversation ends above. This message is a compaction control')) {
    const serialized = args[2].find(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith('['));
    assert(serialized, 'Summary source transcript is observable');
    const source = JSON.parse(serialized.content);
    assert(Array.isArray(source) && source.every(message => typeof message.id === 'string'));
    entry.summarySourceMessages = source.length;
    entry.previouslyArchivedMessagesResummarized = source.filter(message => previouslyArchivedSourceIds.has(message.id)).length;
  }
  evidence.completions.push(entry); await save();
  const started = performance.now();
  const result = await originalGenerate.apply(this, args);
  Object.assign(entry, { elapsedMs: performance.now() - started, success: result.success,
    outputCharacters: result.success ? (result.value.content?.length ?? 0) : 0,
    usage: result.success ? result.value.fullResponse?.usage : undefined,
    errorCode: result.success ? undefined : result.error?.code,
    errorMessage: result.success ? undefined : String(result.error?.message ?? '').replaceAll(key || '__no_key__', '[private]') });
  if (result.success) await fs.writeFile(path.join(profile, 'completion-' + evidence.completions.length + '.txt'), result.value.content ?? '');
  await save();
  console.log(JSON.stringify({ completion: evidence.completions.length, ...entry }));
  return result;
};
let peakRss = 0, peakHeap = 0;
const memorySampler = setInterval(() => { const usage = process.memoryUsage();
  peakRss = Math.max(peakRss, usage.rss); peakHeap = Math.max(peakHeap, usage.heapUsed); }, 1000);
// This standalone acceptance process has no HTTP listener. Keep it alive while
// production retry timers are unref'ed; finally clears the sampler on completion.
const sharp = require('sharp');
try {
  const discovery = await load('Codex subscription login is unavailable');
  const fetchCodexModels = select(discovery, value => typeof value === 'function' && value.toString().includes('model/list'));
  const discovered = await fetchCodexModels();
  const lunaInfo = discovered.find(model => model.id === 'gpt-6-luna');
  assert(lunaInfo, 'Approved subscription model must exist in the live account catalogue');
  evidence.authentication = { model: 'gpt-6-luna', route: 'codex-cli', apiKeyEmpty: true,
    verifiedAccountType: 'chatgpt', verification: 'production fetchCodexModels checks account/read before model/list',
    contextWindow: lunaInfo.contextWindow ?? null };
  const luna = { ...lunaSource, id: 'stress-luna', displayName: 'Stress Luna', ApiKey: '', reasoningEffort: 'low',
    contextWindow: lunaInfo.contextWindow ?? lunaSource.contextWindow, maxTokens: 4000, fallbackPolicy: undefined };
  const savedLuna = await modelService.getModel(luna.id);
  if (savedLuna) {
    assert(['resume', 'recover', 'free-resume', 'recall-replay', 'recall-holdout', 'recall-id-replay', 'crop-replay'].includes(mode), 'Only restart tests reuse an existing model profile');
    assert.equal(savedLuna.name, luna.name); assert.equal(savedLuna.adapter, 'codex-cli');
    assert(!savedLuna.ApiKey?.trim() && !savedLuna.fallbackPolicy, 'Existing profile remains subscription-only');
    assert.equal(savedLuna.contextWindow, luna.contextWindow, 'Catalogue window changed; requalify settings');
  } else assert((await modelService.addModel(luna)).success, 'Save isolated Luna');
  let free;
  if (imageMode) {
    const catalog = await (await fetch('https://openrouter.ai/api/v1/models')).json();
    const entry = catalog.data.find(model => model.id === 'openrouter/free');
    assert(entry && entry.pricing.prompt === '0' && entry.pricing.completion === '0');
    free = { ...freeSource, id: 'stress-free', displayName: 'Stress Free', ApiKey: key, adapter: 'openai',
      contextWindow: entry.context_length, maxTokens: 4000, inputModalities: ['text', 'image'], visionInputCapability: 'supported', fallbackPolicy: undefined };
    const savedFree = await modelService.getModel(free.id);
    if (savedFree) {
      assert(['free-resume', 'crop-replay'].includes(mode));
      assert.equal(savedFree.name, 'openrouter/free');
      assert.equal(savedFree.provider, 'openrouter');
      assert.equal(new URL(savedFree.baseUrl).origin, 'https://openrouter.ai');
      assert(!savedFree.fallbackPolicy);
      assert.equal(savedFree.contextWindow, free.contextWindow);
    } else assert((await modelService.addModel(free)).success, 'Save isolated Free');
  }
  const call = async (model, messages, name, extra = {}) => {
    const restored = extra.restoredState; delete extra.restoredState;
    const conversationId = restored?.conversationId ?? 'stress-' + randomUUID();
    const state = { ...restored, trackingInfo: { executionId: randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
      messages, flowId: 'stress-flow', conversationId, status: 'running', title: name, createdAt: Date.now(), updatedAt: Date.now() };
    FlowExecutor.conversationStates.set(conversationId, state);
    const item = { name, model: model.name, adapter: model.adapter, contextWindow: model.contextWindow,
      canonicalMessages: messages.length, conversationId, startedUtc: new Date().toISOString() };
    evidence.cases.push(item); await save();
    const started = performance.now();
    const inputCount = messages.length;
    const inputDigest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    const input = { modelId: model.id, prompt: '', messages, iteration: 1, maxIterations: 20,
      nodeId: 'stress-node', nodeName: 'Stress', conversationId, runId: randomUUID(), archiveModelTurns: true,
      maxTokens: 1500, requireToolApproval: false, onApprovalRequired: 'fail',
      onFinalWire: wire => { item.wireMessages = wire.length; item.wireCharacters = JSON.stringify(wire).length;
        item.images = wire.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])
          .map(part => ({ encodedCharacters: part.image_url.url.length })); }, ...extra };
    let result = await ModelHandler.callModel(input);
    item.recoveryTools = [];
    for (let step = 0; result.success && result.value.toolCalls?.length && step < 8; step++) {
      const calls = result.value.toolCalls;
      assert(calls.every(call => call.name === 'read_resource'), 'Acceptance permits resource reads only');
      for (const message of result.value.messages ?? []) if (!messages.some(existing => existing.id === message.id)) messages.push(message);
      const processed = await ModelHandler.processToolCalls({
        toolCalls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
        toolNameMap: {}, conversationId, runId: input.runId, node: { nodeId: 'stress-node', nodeType: 'process' },
      });
      assert(processed.success, 'Actual resource tool processing');
      messages.push(...processed.value.toolCallMessages);
      item.recoveryTools.push(...calls.map(call => ({ name: call.name, args: call.args })));
      await save();
      result = await ModelHandler.callModel({ ...input, iteration: step + 2 });
    }
    Object.assign(item, { elapsedMs: performance.now() - started, success: result.success,
      canonicalUnchanged: createHash('sha256').update(JSON.stringify(messages.slice(0, inputCount))).digest('hex') === inputDigest,
      summaryRanges: state.compactionState?.artifacts?.[0]?.summaryRanges?.length ?? 0,
      summaryResourceUri: state.compactionState?.artifacts?.[0]?.summaryResourceUri,
      response: result.success ? result.value.content : undefined,
      toolCalls: result.success ? result.value.toolCalls : undefined,
      usage: result.success ? result.value.fullResponse?.usage : undefined,
      providerModel: result.success ? result.value.fullResponse?.model : undefined,
      error: result.success ? undefined : result.error });
    item.nativeResourceReads = result.success ? (result.value.messages ?? []).flatMap(message => message.tool_calls ?? [])
      .filter(call => call.function?.name === 'read_resource').map(call => ({ name: call.function.name, args: JSON.parse(call.function.arguments) })) : [];
    await save();
    assert(result.success, name + ': ' + JSON.stringify(result.error));
    assert(item.canonicalUnchanged, 'Canonical input must survive');
    const recorded = new Set(messages.map(message => message.id));
    for (const message of result.value.messages ?? []) if (!recorded.has(message.id)) { messages.push(message); recorded.add(message.id); }
    state.status = 'completed'; state.updatedAt = Date.now();
    await persistConversationState('conversations/' + conversationId, state);
    console.log(JSON.stringify({ case: name, success: true, elapsedMs: item.elapsedMs, response: item.response, summaryRanges: item.summaryRanges }));
    return { result, item, state };
  };
  if (mode === 'regions') {
    const code = 'CHECK-' + String(Number.parseInt(randomUUID().slice(0, 6), 16) % 1_000_000).padStart(6, '0');
    const bytes = await sharp({ create: { width: 7680, height: 4320, channels: 3, background: '#48738b' } })
      .composite([{ input: Buffer.from('<svg width="7680" height="4320"><rect x="5600" y="160" width="1600" height="300" fill="white"/>'
        + '<text x="5700" y="340" font-size="64" font-family="monospace" fill="black">' + code + '</text></svg>') }]).png().toBuffer();
    evidence.fixture = { dimensions: [7680, 4320], bytes: bytes.length, code, region: { left: 5600, top: 160, width: 1600, height: 300 } };
    await fs.writeFile(path.join(root, 'stress-8k-fine-print.png'), bytes);
    const tiny = { ...free, id: 'stress-free-tiny', displayName: 'Stress Free 2K advertised budget', contextWindow: 2048, maxTokens: 256 };
    assert((await modelService.addModel(tiny)).success);
    for (const model of [luna, free, tiny]) {
      const messages = [{ id: randomUUID(), timestamp: Date.now(), role: 'user', content: [
        { type: 'text', text: 'Read the small code in the white box near the upper-right corner. Verify it using read_resource with an image_region crop of the original image (the box is around left 5600, top 160, width 1600, height 300). Return only the exact code.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } },
      ] }];
      const { item } = await call(model, messages, '8K fine print with actual image-region recovery', model === tiny ? { maxTokens: 256 } : {});
      item.correctVisualCode = item.response.trim() === code;
      item.usedCrop = [...item.recoveryTools, ...item.nativeResourceReads].some(call => call.args?.image_region);
      item.maxReportedTotalTokens = Math.max(...evidence.completions.filter(entry => entry.modelId === model.id)
        .map(entry => entry.usage?.total_tokens ?? Infinity));
      item.withinAdvertisedWindow = item.maxReportedTotalTokens <= model.contextWindow;
      await save();
    }
    assert(evidence.cases.every(item => item.correctVisualCode && item.usedCrop), 'Every route must execute an image crop and read its exact code');
    assert(evidence.cases.every(item => item.withinAdvertisedWindow), 'Reported prompt plus output must fit each advertised window, not only the local estimate');
  } else if (mode === 'images') {
    const code = reusedFixture?.code ?? 'FLUJO-' + randomUUID().slice(0, 8).toUpperCase();
    const tile = Buffer.alloc(512 * 512 * 3); let seed = 123456;
    for (let i = 0; i < tile.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; tile[i] = seed >>> 24; }
    const image = reusedFixture ? await fs.readFile(path.join(root, 'stress-8k.png')) : await sharp(tile, { raw: { width: 512, height: 512, channels: 3 } }).resize(7680, 4320, { kernel: 'nearest' })
      .composite([{ input: Buffer.from('<svg width="7680" height="4320"><rect x="700" y="1300" width="6280" height="1700" fill="white"/>'
        + '<text x="900" y="2250" font-size="500" font-family="Arial" fill="black">' + code + '</text></svg>') }]).png().toBuffer();
    evidence.fixture = { dimensions: [7680, 4320], bytes: image.length, code };
    await fs.writeFile(path.join(root, 'stress-8k.png'), image);
    const messages = () => [{ id: randomUUID(), timestamp: Date.now(), role: 'user', content: [
      { type: 'text', text: 'Read the large code in the white panel. Return only that exact code. You may use read_resource to inspect the image if necessary.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.toString('base64') } },
    ] }];
    for (const model of [free, luna]) {
      const { item } = await call(model, messages(), '8K image, discovered model limits');
      item.correctVisualCode = item.response.trim() === code;
      await save();
    }
    const tiny = { ...free, id: 'stress-free-tiny', displayName: 'Stress Free 2K advertised budget', contextWindow: 2048, maxTokens: 256 };
    assert((await modelService.addModel(tiny)).success);
    const { item } = await call(tiny, messages(), '8K image, simulated 2048-token advertised window', { maxTokens: 256 });
    item.correctVisualCode = item.response.trim() === code;
    await save();
    assert(evidence.cases.every(item => item.correctVisualCode), 'Every route must read the exact visual code');
  } else if (mode === 'crop-replay') {
    const failed = JSON.parse(await fs.readFile(path.join(root, 'live-regions-paging-overbudget.json'), 'utf8'));
    assert.equal(failed.status, 'failed');
    assert.equal(profile, failed.profile);
    const originalCase = failed.cases.find(item => item.contextWindow === 2048);
    const statePath = path.join(profile, 'workspaces/default-workspace/db/conversations', originalCase.conversationId + '.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await fs.copyFile(statePath, path.join(root, 'failed-crop-canonical-snapshot.json'));
    const toolIndex = state.messages.findIndex(message => message.role === 'assistant' && message.tool_calls?.length);
    assert(toolIndex > 0);
    const calls = state.messages[toolIndex].tool_calls;
    assert(calls.every(call => call.function.name === 'read_resource' && JSON.parse(call.function.arguments).image_region));
    const messages = state.messages.slice(0, toolIndex + 1);
    FlowExecutor.conversationStates.set(state.conversationId, { ...state, messages });
    // Replay the exact saved read-only tool arguments through production so the
    // new crop metadata is tested even if a model can read the overview unaided.
    const processed = await ModelHandler.processToolCalls({ toolCalls: calls, toolNameMap: {},
      conversationId: state.conversationId, runId: randomUUID(), node: { nodeId: 'stress-node', nodeType: 'process' } });
    assert(processed.success);
    messages.push(...processed.value.toolCallMessages);
    const tiny = await modelService.getModel('stress-free-tiny');
    assert.equal(tiny.name, 'openrouter/free'); assert.equal(tiny.contextWindow, 2048); assert(!tiny.fallbackPolicy);
    const { item } = await call(tiny, messages, 'Exact production crop continuation under 2048-token advertised budget',
      { maxTokens: 256, restoredState: state });
    item.correctVisualCode = item.response.trim() === failed.fixture.code;
    item.maxReportedTotalTokens = Math.max(...evidence.completions.map(entry => entry.usage?.total_tokens ?? Infinity));
    item.withinAdvertisedWindow = item.maxReportedTotalTokens <= 2048;
    evidence.fixture = failed.fixture;
    evidence.replayedReadOnlyToolCalls = calls;
    await save();
    assert(item.correctVisualCode, 'Exact saved crop code must be read correctly');
    assert(item.withinAdvertisedWindow, 'Reported prompt plus output must fit the advertised window');
  } else if (mode === 'recall-id-replay') {
    const failed = JSON.parse(await fs.readFile(path.join(root, 'live-recall-message-id-failure.json'), 'utf8'));
    assert.equal(failed.status, 'failed');
    const failedCase = failed.cases.find(item => item.name === 'Held-out question: verbatim');
    assert(failedCase);
    const statePath = path.join(profile, 'workspaces/default-workspace/db/conversations', failedCase.conversationId + '.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await fs.copyFile(statePath, path.join(root, 'failed-message-id-canonical-snapshot.json'));
    const messages = state.messages.slice(0, failedCase.canonicalMessages);
    assert.equal(messages.at(-1).role, 'user');
    assert(messages.at(-1).content.includes('history-0'));
    const expected = { originalMessage: messages.find(message => message.id === 'history-0').content };
    const { item } = await call(luna, messages, 'Exact failed message-ID request replay', { restoredState: state });
    assert.deepEqual(JSON.parse(item.response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), expected);
    item.answerVerified = true;
  } else if (mode === 'recall-holdout') {
    const original = JSON.parse(await fs.readFile(path.join(root, 'live-long-recovery-receipt.json'), 'utf8'));
    const conversationId = original.restartReadyConversation;
    const state = JSON.parse(await fs.readFile(path.join(profile, 'workspaces/default-workspace/db/conversations', conversationId + '.json'), 'utf8'));
    const cases = [
      ['temporal', 'What destination was recorded before the later correction, and what is the corrected current destination? Return JSON only with oldDestination and currentDestination. No actions.', { oldDestination: 'Quito', currentDestination: original.expected.destination }],
      ['receipt', 'Recover the committed audit receipt from the original observation. Return JSON only with receiptId and committed (boolean). No actions.', { receiptId: original.expected.receipt, committed: true }],
      ['restriction', 'Does the standing instruction permit sending messages or repeating completed operations? Return JSON only with sendingPermitted and repeatCompletedOperationsPermitted, both booleans. No actions.', { sendingPermitted: false, repeatCompletedOperationsPermitted: false }],
      ['abstention', 'What tracking number did the original audit record? Return JSON only with trackingNumber (string or null). Use null if none was recorded; do not substitute the receipt ID or a checkpoint. No actions.', { trackingNumber: null }],
      ['verbatim', 'Quote the full original user message whose source message ID is history-0, with its exact wording. Return JSON only with originalMessage (string). No actions.', { originalMessage: state.messages.find(message => message.id === 'history-0').content }],
    ];
    for (const [name, question, expected] of cases) {
      state.messages.push({ id: randomUUID(), role: 'user', content: question, timestamp: Date.now() });
      const { item } = await call(luna, state.messages, 'Held-out question: ' + name, { restoredState: state });
      assert.deepEqual(JSON.parse(item.response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), expected);
      item.answerVerified = true; await save();
    }
  } else if (mode === 'recall-replay') {
    const failureReceipt = process.env.FLUJO_ACCEPTANCE_FAILURE_RECEIPT ?? 'live-endurance-checkpoint-failure.json';
    assert.equal(path.basename(failureReceipt), failureReceipt);
    const failed = JSON.parse(await fs.readFile(path.join(root, failureReceipt), 'utf8'));
    const original = JSON.parse(await fs.readFile(path.join(root, 'live-long-recovery-receipt.json'), 'utf8'));
    assert.equal(failed.status, 'failed');
    const conversationId = failed.cases[0].conversationId;
    const statePath = path.join(profile, 'workspaces/default-workspace/db/conversations', conversationId + '.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await fs.copyFile(statePath, path.join(root, failureReceipt.replace('.json', '-canonical-snapshot.json')));
    // Reproduce the exact original input prefix, excluding only the failed
    // answer produced after it. No extra hint, new request, or expected value.
    const messages = state.messages.slice(0, failed.cases[0].canonicalMessages);
    assert.equal(messages.at(-1).role, 'user');
    assert(messages.at(-1).content.includes(failed.checkpointAudit.checkpointLabel));
    const { item, state: restored } = await call(luna, messages, 'Exact failed checkpoint request replay', { restoredState: state });
    assert.deepEqual(JSON.parse(item.response.trim()), { destination: original.expected.destination,
      receiptId: original.expected.receipt, permitted: false, checkpointId: failed.checkpointAudit.checkpointId });
    evidence.checkpointAudit = failed.checkpointAudit;
    evidence.expected = original.expected;
    evidence.restartReadyConversation = conversationId;
    evidence.persistedCanonicalMessages = restored.messages.length;
  } else if (mode === 'resume' || mode === 'recover' || mode === 'free-resume') {
    const previousReceipt = JSON.parse(await fs.readFile(path.join(root, mode === 'free-resume' ? 'live-free-long-receipt.json' : mode === 'recover' ? 'live-long-receipt.json' : 'live-long-recovery-receipt.json'), 'utf8'));
    if (mode === 'recover') {
      assert.equal(previousReceipt.status, 'failed');
      assert.equal(previousReceipt.cases[0].error.message, 'Codex run failed: Unexpected Codex tool execution.');
      assert(previousReceipt.cases[0].summaryRanges > 0);
      evidence.recoveredFrom = 'live-long-receipt.json';
    } else assert.equal(previousReceipt.status, 'passed');
    const conversationId = previousReceipt.restartReadyConversation ?? previousReceipt.cases[0].conversationId;
    const state = JSON.parse(await fs.readFile(path.join(profile, 'workspaces/default-workspace/db/conversations', conversationId + '.json'), 'utf8'));
    assert(state.compactionState.artifacts[0].summaryRanges.length > 0);
    const messages = state.messages;
    const archivedEnd = messages.findIndex(message => message.id === state.compactionState.artifacts[0].sourceEndId);
    assert(archivedEnd >= 0, 'Persisted archive boundary must identify an original message');
    previouslyArchivedSourceIds = new Set(messages.slice(0, archivedEnd + 1).map(message => message.id));
    evidence.previouslyArchivedSourceMessages = previouslyArchivedSourceIds.size;
    const appendedCount = Number(process.argv[4] ?? 0);
    assert(Number.isInteger(appendedCount) && appendedCount >= 0 && appendedCount <= 10000);
    const checkpointMode = (mode === 'resume' || mode === 'free-resume') && process.argv[5] === 'checkpoints';
    const checkpointPath = path.join(profile, 'acceptance-checkpoints.json');
    let checkpoints = [], checkpoint;
    if (checkpointMode) {
      try { checkpoints = JSON.parse(await fs.readFile(checkpointPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const added = { checkpointLabel: 'sample-' + randomUUID(), checkpointId: 'nonce-' + randomUUID() };
      checkpoints.push(added);
      messages.push({ id: randomUUID(), timestamp: Date.now(), role: 'assistant',
        content: 'Recorded read-only audit observation: ' + JSON.stringify(added) });
      checkpoint = checkpoints[Math.floor((checkpoints.length - 1) / 3)];
      evidence.checkpointAudit = { ...checkpoint, storedCheckpoints: checkpoints.length };
    }
    for (let index = 0; index < appendedCount; index++) messages.push({ id: randomUUID(), timestamp: Date.now(),
      role: index % 2 ? 'assistant' : 'user', content: index % 2 ? 'This one-off check is complete; no pending action.' : 'Check completed status record ' + index + '.' });
    evidence.appendedMessages = appendedCount;
    messages.push({ id: randomUUID(), role: 'user', timestamp: Date.now(), content: 'Continue the same audit after restarting FLUJO. Return JSON only with the latest destination, receiptId and permitted boolean. '
      + (checkpoint ? 'Also include checkpointId for recorded checkpoint label ' + checkpoint.checkpointLabel + '. Recover the exact archived observation when needed. ' : '') + 'No actions.' });
    const { item } = await call(mode === 'free-resume' ? free : luna, messages, 'Restart with persisted hierarchy and a new user request', { restoredState: state });
    const answer = JSON.parse(item.response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    assert.deepEqual(answer, { destination: previousReceipt.expected.destination, receiptId: previousReceipt.expected.receipt, permitted: false,
      ...(checkpoint ? { checkpointId: checkpoint.checkpointId } : {}) });
    assert(evidence.completions.every(entry => !entry.previouslyArchivedMessagesResummarized), 'Restart must not resummarize any previously archived original message');
    evidence.previouslyArchivedMessagesResummarized = evidence.completions.reduce((total, entry) => total + (entry.previouslyArchivedMessagesResummarized ?? 0), 0);
    evidence.expected = previousReceipt.expected;
    evidence.restartReadyConversation = conversationId;
    evidence.persistedCanonicalMessages = state.messages.length;
    if (checkpointMode) await fs.writeFile(checkpointPath, JSON.stringify(checkpoints));
  } else {
    const destination = 'Bogotá-' + randomUUID().slice(0, 8), receipt = 'receipt-' + randomUUID().slice(0, 8);
    evidence.expected = { destination, receipt, permitted: false };
    const historyCount = mode === 'free-long' ? 80_000 : 200_000;
    const messages = Array.from({ length: historyCount }, (_, index) => ({ id: 'history-' + index, timestamp: index + 1,
      role: index % 2 ? 'assistant' : 'user', content: index % 2 ? 'That one-off status check is complete. No pending action.' : 'Check completed record ' + index + '.' }));
    messages[0].content = 'We are auditing a long history. Standing rule: never send messages, publish, delete, or repeat completed operations. Destination is initially Quito. Keep these constraints throughout.';
    messages[12345].content = 'Authoritative observed result for the audit: ' + JSON.stringify({ receiptId: receipt, permitted: false, committed: true });
    messages[Math.floor(historyCount * 0.65)].content = 'Correction for the continuing audit: destination is ' + destination + '. This replaces Quito. Sending remains prohibited.';
    messages.at(-2).content = 'Return JSON only with destination (latest corrected exact string), receiptId (exact committed audit receipt), and permitted (boolean). Do not perform actions. Recover the source if necessary.';
    messages.pop();
    const { item, state } = await call(mode === 'free-long' ? free : luna, messages,
      (historyCount - 1) + '-message actual compaction and continuation');
    assert(item.summaryRanges > 0, 'Production hierarchy must actually compact');
    const answer = JSON.parse(item.response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    assert.deepEqual(answer, { destination, receiptId: receipt, permitted: false });
    const savedState = JSON.parse(await fs.readFile(path.join(profile, 'workspaces/default-workspace/db/conversations', state.conversationId + '.json'), 'utf8'));
    assert(savedState.compactionState.artifacts[0].summaryRanges.length > 0, 'Hierarchy persisted with canonical source');
    evidence.restartReadyConversation = state.conversationId;
    evidence.persistedCanonicalMessages = savedState.messages.length;
  }
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = String(error.stack ?? error).replaceAll(key || '__no_key__', '[private]');
  process.exitCode = 1;
} finally {
  clearInterval(memorySampler);
  evidence.peakMemory = { rssBytes: peakRss, heapUsedBytes: peakHeap, samplingMs: 1000 };
  evidence.finishedUtc = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: evidence.status, report, error: evidence.error }));
}
