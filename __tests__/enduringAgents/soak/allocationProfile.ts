import { promises as fs } from 'node:fs';
import { Session, type HeapProfiler } from 'node:inspector';
import path from 'node:path';

/** Diagnostic only: capture allocation stacks before Jest disposes the workload VM. */
export async function withSoakAllocationProfile<T>(run: () => Promise<T>): Promise<T> {
  if (process.env.PERSONA_SOAK_PROFILE_ALLOCATIONS !== '1') return run();
  const directory = process.env.PERSONA_SOAK_OUTPUT;
  if (process.env.PERSONA_SOAK_MODE !== 'infrastructure' || !directory) {
    throw new Error('Allocation profiling requires infrastructure mode and an output directory.');
  }
  const session = new Session();
  session.connect();
  const parameters = {
    samplingInterval: 512 * 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      session.post('HeapProfiler.startSampling', parameters, error => error ? reject(error) : resolve());
    });
    try {
      return await run();
    } finally {
      const memoryBeforeProfile = process.memoryUsage();
      const result = await new Promise<HeapProfiler.StopSamplingReturnType>((resolve, reject) => {
        session.post('HeapProfiler.stopSampling', (error, profile) => error ? reject(error) : resolve(profile));
      });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'workload-allocation-profile.heapprofile'), JSON.stringify(result.profile));
      await fs.writeFile(path.join(directory, 'workload-allocation-profile.json'), JSON.stringify({
        diagnosticOnly: true, parameters, memoryBeforeProfile,
        capturedBeforeJestTeardown: true, node: process.version,
      }, null, 2) + '\n');
    }
  } finally {
    session.disconnect();
  }
}
