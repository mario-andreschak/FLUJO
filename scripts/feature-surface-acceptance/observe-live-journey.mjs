import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFINITION_SHA256, FIXTURE_VERSION } from './fixture-server.mjs';
import { boundedJson, collectLiveEvents, createProjectionBudget, digest, evaluateLiveJourney, loopbackOrigin,
  ownerRequest, projectConversationStatus, projectFixtureReceipt, projectModelInput,
  serializeEvidenceReport } from './live-journey-observer.mjs';

const { values } = parseArgs({ options: Object.fromEntries([
  'base-url', 'workspace', 'conversation', 'flow-id', 'model-id', 'tool-name', 'fixture-tool-name',
  'fixture-url', 'candidate-receipt-sha256', 'output-dir', 'duration-seconds',
].map(name => [name, { type: 'string' }])) });
for (const name of ['base-url', 'workspace', 'conversation', 'flow-id', 'model-id', 'tool-name',
  'fixture-url', 'candidate-receipt-sha256', 'output-dir']) {
  if (!values[name]) throw new Error(`Missing --${name}. See live-journey.md.`);
}
if (!/^[a-f0-9]{64}$/.test(values['candidate-receipt-sha256'])) throw new Error('Expected an owner candidate receipt SHA-256.');
const seconds = Number(values['duration-seconds'] ?? '900');
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 900) throw new Error('Duration must be 10..900 seconds.');
const fixtureOrigin = loopbackOrigin(values['fixture-url']);
const baseURL = loopbackOrigin(values['base-url']);
const output = path.resolve(values['output-dir']);
// A new output directory keeps failed/partial observations distinct from later attempts.
await fs.mkdir(output, { recursive: false });
const eventsFile = path.join(output, 'execution-projection.jsonl');
const stream = createWriteStream(eventsFile, { flags: 'wx' });
const report = {
  schemaVersion: 2, scope: 'Attached technical observation of an owner-provisioned local first-use run',
  startedAtUtc: new Date().toISOString(), completedAtUtc: null, status: 'incomplete',
  candidateReceiptSha256: values['candidate-receipt-sha256'], sourceArtifactCorrespondence: 'not_verified_by_observer',
  realProviderIdentity: 'not_verified_by_observer', humanPilot: 'not_evaluated', fullFeatureAcceptance: false,
  baseURL, workspace: values.workspace, conversationId: values.conversation, flowId: values['flow-id'],
  modelId: values['model-id'], toolName: values['tool-name'], fixtureToolName: values['fixture-tool-name'] ?? 'fixture_tool_128',
  observerStartsOrResumesRuns: false, observerApprovesTools: false, observerTransfersCredentials: false,
  events: [], modelInputs: [], gradeAwarded: false,
};
const controller = new AbortController();
const projectionBudget = createProjectionBudget();
let streamError;
stream.on('error', error => { streamError = error; controller.abort(error); });
const deadline = setTimeout(() => controller.abort(new Error('Live observer deadline exceeded.')), seconds * 1000);
const request = ownerRequest(baseURL, values.workspace);
const json = async route => boundedJson(await request(route, { signal: controller.signal }));
const fixtureReceipt = async () => {
  const response = await fetch(`${fixtureOrigin}/receipt`, { redirect: 'error', signal: controller.signal });
  if (!response.ok) throw new Error(`Fixture receipt returned ${response.status}.`);
  return projectFixtureReceipt(await boundedJson(response, 256 * 1024), DEFINITION_SHA256, FIXTURE_VERSION);
};
const conversationRoute = `/v1/chat/conversations/${encodeURIComponent(values.conversation)}`;
let failed;
try {
  const before = await json(conversationRoute);
  const beforeTurns = await json(`${conversationRoute}/model-turns`);
  if (before.id !== values.conversation || before.flowId !== values['flow-id'] || before.personaId
    || !Array.isArray(before.messages) || before.messages.some(message => ['assistant', 'tool'].includes(message.role))
    || beforeTurns.conversationId !== values.conversation || !Array.isArray(beforeTurns.turns) || beforeTurns.turns.length) {
    throw new Error('Use a fresh UI-created ordinary agent conversation before its first model dispatch.');
  }
  report.fixtureBefore = projectionBudget.admit(await fixtureReceipt());
  if (report.fixtureBefore.definitionSha256 !== DEFINITION_SHA256 || report.fixtureBefore.mode !== 'normal') {
    throw new Error('Use the selected owned feature fixture in normal mode.');
  }
  const response = await request(`${conversationRoute}/events?fromSeq=0`, { signal: controller.signal });
  console.log('Observer attached. The owner may now perform the approved UI run, approval and debugger steps.');
  await collectLiveEvents(response, values.conversation, { onEvent: event => {
    projectionBudget.admit(event);
    report.events.push(event);
    stream.write(JSON.stringify(event) + '\n');
  } });
  report.fixtureAfter = projectionBudget.admit(await fixtureReceipt());
  const finalState = await json(`${conversationRoute}?messageLimit=8&compactToolPayloads=1`);
  if (finalState.id !== values.conversation || finalState.flowId !== values['flow-id']) {
    throw new Error('The UI conversation identity changed during observation.');
  }
  report.finalConversationStatus = projectConversationStatus(finalState.status);
  for (const dispatch of report.events.filter(event => event.type === 'model:dispatch' && event.depth === 0)) {
    const snapshot = await json(`${conversationRoute}/model-turns/${encodeURIComponent(dispatch.dispatchId)}`);
    report.modelInputs.push(projectionBudget.admit(projectModelInput(snapshot, values.conversation, dispatch.dispatchId)));
  }
  report.evaluation = evaluateLiveJourney({ ...report, events: report.events, modelInputs: report.modelInputs });
  report.status = report.evaluation.componentPassed && finalState.status === 'completed' ? 'component_passed' : 'incomplete';
  if (report.status !== 'component_passed') throw new Error('One or more live journey observations are missing or failed.');
} catch (error) {
  failed = error;
  // Do not persist provider text or HTTP response bodies through an exception.
  report.failure = { name: 'ObservationError',
    message: 'Observation stopped; preserve this partial receipt and inspect the owner runtime separately.' };
  report.status = 'incomplete';
} finally {
  clearTimeout(deadline); controller.abort();
  try { if (!streamError) await new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); }); }
  catch (error) { streamError = error; }
  if (streamError) { failed ??= streamError; report.status = 'incomplete'; report.failure = { name: 'EvidenceWriteError',
    message: 'The execution projection could not be completely retained.' }; }
  report.completedAtUtc = new Date().toISOString();
  report.projectionBudget = { maximumBytes: projectionBudget.maximumBytes, retainedBytes: projectionBudget.usedBytes() };
  report.raw = streamError ? [] : [{ file: 'execution-projection.jsonl', sha256: digest(await fs.readFile(eventsFile)) }];
  await fs.writeFile(path.join(output, 'live-journey-observation.json'), serializeEvidenceReport(report), { flag: 'wx' });
}
console.log(JSON.stringify({ status: report.status, report: path.join(output, 'live-journey-observation.json'),
  fullFeatureAcceptance: false, gradeAwarded: false }));
if (failed) process.exitCode = 1;
