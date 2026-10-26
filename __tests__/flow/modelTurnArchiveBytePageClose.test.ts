import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, preparePagedCanonicalArchive } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

// Quarantine intentionally survives for this test environment's lifetime.
// Keep this in a separate Jest environment; do not reset production ledgers.
it('quarantines writer admission when a canonical page descriptor reports an uncertain close', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-byte-close-'));
  const previous = _setModelTurnArchiveDirForTests(directory);
  try {
    const canonicalArchive = await preparePagedCanonicalArchive('close-failure', [
      { id: 'history', role: 'user', timestamp: 1, content: 'unchanged history' },
    ]);
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.json.gz')) {
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => {
          // Close the real equipment descriptor, but expose the uncertain
          // filesystem result. Production must not infer successful drainage.
          await close();
          throw new Error('reported close uncertainty');
        });
      }
      return handle;
    });
    await expect(archiveModelDispatch({
      conversationId: 'close-failure', nodeId: 'process', modelId: 'test', modelName: 'test',
      adapter: 'openai', operation: 'create', attempt: 1, canonicalArchive,
      canonicalMessages: [], genericWire: [], sdkRequest: {},
    })).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' });
    expect(getArchiveWritePressure().quarantined).toBe(1);
    expect(getArchiveWritePressure().bytes).toBeGreaterThan(0);
    expect(getArchiveWritePressure().writers).toBe(1);
    expect((await fs.readdir(path.join(directory, 'close-failure'))).some(name => name.endsWith('.v2.json.gz'))).toBe(false);
  } finally {
    jest.restoreAllMocks();
    _setModelTurnArchiveDirForTests(previous);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
