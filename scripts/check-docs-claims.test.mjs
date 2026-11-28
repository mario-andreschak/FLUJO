import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDITED_FEATURES, PROJECT_STATUS, README, SECURITY, checkDocsClaims, readClaimFiles,
} from './check-docs-claims.mjs';

const readme = [
  '### AI Setup', 'Connect model connections.', '### Connected Apps (MCP)', '### Agent Builder', 'Debugging and tool approvals.',
  '### Automations', 'An OpenAI-compatible API and an MCP proxy.',
  '| Meetings, Personas and Waves | Experimental |',
  '| Shared or team use (several users on one FLUJO) | Not supported yet |',
].join('\n');
const status = [
  '| Personas | Experimental |', '| Meetings and Waves | Experimental |',
  '| Shared or team use (several users on one FLUJO) | Not supported |',
].join('\n');
const good = { [README]: readme, [PROJECT_STATUS]: status, [SECURITY]: '# Security' };
const ids = (problems) => problems.map((problem) => `${problem.file}:${problem.id}`);

test('the docs of the working tree pass', async () => {
  assert.deepEqual(checkDocsClaims(await readClaimFiles()), []);
});

test('a minimal honest set of pages passes', () => {
  assert.deepEqual(checkDocsClaims(good), []);
});

test('an experimental capability without its label fails in the page that lost it', () => {
  const problems = checkDocsClaims({ ...good, [PROJECT_STATUS]: status.replace('| Meetings and Waves | Experimental |', '| Meetings and Waves | Available |') });
  assert.deepEqual(ids(problems), [`${PROJECT_STATUS}:experimental-meetings`, `${PROJECT_STATUS}:experimental-waves`]);
  assert.match(problems[0].detail, /Add it to the status table/);
});

test('a page that stops naming the unsupported shared profile fails', () => {
  const problems = checkDocsClaims({ ...good, [README]: readme.replace('| Shared or team use (several users on one FLUJO) | Not supported yet |', '') });
  assert.deepEqual(ids(problems), [`${README}:deferred-shared-team`]);
});

test('a claim without evidence fails with its line; a negated one passes', () => {
  const claimed = { ...good, [SECURITY]: '# Security\nFLUJO is secure by default.\nFLUJO is not production-ready for teams.' };
  const problems = checkDocsClaims(claimed);
  assert.deepEqual(ids(problems), [`${SECURITY}:claim-secure-by-default`]);
  assert.equal(problems[0].line, 2);
  assert.match(problems[0].detail, /SECURITY\.md:2 claims "secure by default"/);
});

test('dropping an audited feature from the README is reported as a scope cut', () => {
  const problems = checkDocsClaims({ ...good, [README]: readme.replace('An OpenAI-compatible API and an MCP proxy.', '') });
  assert.deepEqual(ids(problems), [`${README}:feature-openai-api`, `${README}:feature-mcp-proxy`]);
  assert.equal(AUDITED_FEATURES.length, 8);
});

test('a missing page is a problem, not a crash', () => {
  assert.deepEqual(ids(checkDocsClaims({ [README]: readme })), [`${PROJECT_STATUS}:missing-file`]);
});
