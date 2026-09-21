import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateJourneyReport } from './evidence.mjs';

const { values } = parseArgs({ options: { commit: { type: 'string' }, 'run-id': { type: 'string' },
  'build-id': { type: 'string' }, directory: { type: 'string', default: 'persona-browser-artifacts' } } });
const identity = { commit: values.commit, runId: values['run-id'], buildId: values['build-id'] };
const read = async name => JSON.parse(await fs.readFile(path.join(values.directory, name), 'utf8'));
let result;
try {
  const [report, before, after] = await Promise.all(['report.json', 'source-before.json', 'source-after.json'].map(read));
  result = validateJourneyReport(report, identity, before, after);
} catch (error) {
  result = { schemaVersion: 1, verdict: 'failed', identity, reason: error.message };
  process.exitCode = 1;
}
await fs.mkdir(values.directory, { recursive: true });
await fs.writeFile(path.join(values.directory, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
