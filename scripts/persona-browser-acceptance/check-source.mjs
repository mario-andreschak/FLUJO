import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertExactPersonaAcceptanceSource } from '../persona-acceptance-source.mjs';
import { validateJourneyIdentity } from './evidence.mjs';

const { values } = parseArgs({ options: { commit: { type: 'string' }, 'run-id': { type: 'string' },
  phase: { type: 'string' }, directory: { type: 'string', default: 'persona-browser-artifacts' } } });
if (!['before', 'after'].includes(values.phase)) throw new Error('phase must be before or after.');
await fs.mkdir(values.directory, { recursive: true });
const identity = { commit: values.commit, runId: values['run-id'], buildId: null };
let record;
try {
  identity.buildId = (await fs.readFile('.next/BUILD_ID', 'utf8')).trim();
  validateJourneyIdentity(identity);
  assertExactPersonaAcceptanceSource(identity.commit);
  record = { schemaVersion: 1, verdict: 'passed', phase: values.phase, identity, observedAt: new Date().toISOString() };
} catch (error) {
  record = { schemaVersion: 1, verdict: 'failed', phase: values.phase, identity, observedAt: new Date().toISOString(), reason: error.message };
  process.exitCode = 1;
}
// A failed repeat overwrites a previous passing check, so stale provenance fails closed.
await fs.writeFile(path.join(values.directory, `source-${values.phase}.json`), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
