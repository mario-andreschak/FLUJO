import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

async function listFilesRecursively(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function visitObjects(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, visit);
    return;
  }
  for (const item of Object.values(value)) visitObjects(item, visit);
}

function parseRecords(filename, raw) {
  if (filename.endsWith('.jsonl')) {
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  if (filename.endsWith('.json')) return [JSON.parse(raw)];
  return [];
}

function authoritativeRecords(candidates, kind) {
  const records = [];
  for (const [id, matches] of candidates) {
    const distinct = new Set(matches.map(match => stableJson(match.record)));
    if (distinct.size !== 1) {
      throw new Error('Conflicting persisted ' + kind + ' records share identity: ' + id);
    }
    if (matches.length !== 1) {
      throw new Error('Persisted ' + kind + ' record is duplicated across runtime sources: ' + id);
    }
    records.push(matches[0]);
  }
  return records;
}

export async function writeRuntimeProvenanceEvidence({
  runtimeData,
  reportPath,
  outputPath,
  runId,
}) {
  const runtimeRoot = path.resolve(runtimeData);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const expectedEvents = [...(report.runtimeEvents ?? [])]
    .sort((left, right) => left.seq - right.seq);
  const expectedDispatches = [...(report.dispatches ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id));
  const workspaceId = report.configuration?.workspaceId;
  const personaId = report.configuration?.personaId;
  if (!workspaceId || !personaId || !report.configuration?.goalId) {
    throw new Error('The endurance report lacks runtime provenance scope.');
  }
  const eventCandidates = new Map();
  const dispatchCandidates = new Map();

  const files = (await listFilesRecursively(runtimeRoot))
    .filter(filename => filename.endsWith('.json') || filename.endsWith('.jsonl'));
  for (const filename of files.sort()) {
    const raw = await fs.readFile(filename, 'utf8');
    const source = path.relative(runtimeRoot, filename).split(path.sep).join('/');
    const sourceFileSha256 = sha256(raw);
    for (const root of parseRecords(filename, raw)) {
      visitObjects(root, record => {
        if (typeof record.eventId === 'string'
          && typeof record.type === 'string'
          && Number.isSafeInteger(record.seq)
          && record.workspaceId === workspaceId
          && record.personaId === personaId) {
          const values = eventCandidates.get(record.eventId) ?? [];
          values.push({ record, source, sourceFileSha256 });
          eventCandidates.set(record.eventId, values);
        }
        if (typeof record.id === 'string'
          && record.workspaceId === workspaceId
          && record.personaId === personaId
          && record.admission
          && typeof record.state === 'string') {
          const values = dispatchCandidates.get(record.id) ?? [];
          values.push({ record, source, sourceFileSha256 });
          dispatchCandidates.set(record.id, values);
        }
      });
    }
  }

  const runtimeEvents = authoritativeRecords(eventCandidates, 'runtime event')
    .sort((left, right) => left.record.seq - right.record.seq);
  const dispatches = authoritativeRecords(dispatchCandidates, 'dispatch')
    .sort((left, right) => left.record.id.localeCompare(right.record.id));
  if (stableJson(runtimeEvents.map(value => value.record)) !== stableJson(expectedEvents)) {
    throw new Error('The report omits or alters durable Persona runtime events.');
  }
  if (stableJson(dispatches.map(value => value.record)) !== stableJson(expectedDispatches)) {
    throw new Error('The report omits or alters durable Persona dispatches.');
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    collectedAt: new Date().toISOString(),
    sourceRoot: 'runtime-data',
    runtimeEvents,
    dispatches,
  };
  await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
