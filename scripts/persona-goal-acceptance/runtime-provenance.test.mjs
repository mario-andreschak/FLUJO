import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRuntimeProvenanceEvidence } from './runtime-provenance.mjs';

test('collects actual workspace setup and rejects omitted or duplicate Activities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flujo-endurance-setup-'));
  try {
    const runtimeData = path.join(root, 'runtime-data');
    const db = path.join(runtimeData, 'workspaces', 'workspace', 'db');
    const persona = { id: 'persona', roleVersionId: 'version', name: 'Frederik' };
    const version = { id: 'version', roleDefinitionId: 'role', name: 'Marketing Agent' };
    const definition = { id: 'role', name: 'Marketing Agent', currentVersionId: 'version' };
    const activity = { id: 'activity', personaId: 'persona', status: 'completed' };
    const records = [
      ['personas', persona], ['role-versions', version], ['role-definitions', definition],
      ['persona-activities/shard', activity],
      ['persona-activities/shard', { id: 'unrelated', personaId: 'other' }],
    ];
    for (const [collection, record] of records) {
      const directory = path.join(db, collection);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, record.id + '.json'), JSON.stringify(record));
    }
    // An embedded copy is not another authoritative Activity or Role record.
    await mkdir(path.join(db, 'conversations'), { recursive: true });
    await writeFile(path.join(db, 'conversations', 'copy.json'), JSON.stringify({ activity, version }));
    const reportPath = path.join(root, 'report.json');
    const report = { configuration: { workspaceId: 'workspace', personaId: 'persona', goalId: 'goal', roleVersionId: 'version' },
      runtimeEvents: [], dispatches: [], activities: [activity] };
    await writeFile(reportPath, JSON.stringify(report));
    const options = { runtimeData, reportPath, outputPath: path.join(root, 'evidence.json'), runId: 'run' };
    const evidence = await writeRuntimeProvenanceEvidence(options);
    assert.deepEqual(evidence.setup.roleVersion.record, version);
    assert.deepEqual(evidence.activities.map(value => value.record), [activity]);
    const versionBytes = await readFile(path.join(db, 'role-versions', 'version.json'));
    assert.equal(evidence.setup.roleVersion.sourceFileSha256, createHash('sha256').update(versionBytes).digest('hex'));
    await writeFile(reportPath, JSON.stringify({ ...report, activities: [] }));
    await assert.rejects(writeRuntimeProvenanceEvidence(options), /omits or alters durable Persona Activities/);
    await writeFile(reportPath, JSON.stringify(report));
    await writeFile(path.join(db, 'persona-activities', 'duplicate.json'), JSON.stringify(activity));
    await assert.rejects(writeRuntimeProvenanceEvidence(options), /Activity record is duplicated/);
  } finally {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('flujo-endurance-setup-')) {
      throw new Error('Unexpected test cleanup path');
    }
    await rm(root, { recursive: true, force: true });
  }
});
