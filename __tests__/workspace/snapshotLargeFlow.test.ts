import { spawn } from 'node:child_process';
import { constants } from 'node:buffer';
import path from 'node:path';

it('captures, downloads and restores 420 MiB above the legacy string limit with a 128 MiB heap', async () => {
  const child = spawn(process.execPath, ['--max-old-space-size=128',
    path.join(__dirname, 'fixtures', 'snapshot-large-child.cjs'), process.cwd(), require.resolve('typescript')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const timeout = setTimeout(() => child.kill(), 300_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    if (status !== 0) throw new Error(`Large snapshot child failed (${status}): ${errors}`);
    expect(output).toContain('CAPTURED\nWRITTEN\nDOWNLOADED\n');
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result.restored).toBe(3);
    expect(result.wireBytes).toBeGreaterThan(constants.MAX_STRING_LENGTH);
    expect(result.peakRss).toBeGreaterThan(0);
    // Below the captured payload itself: retaining all source buffers must fail this regression.
    expect(result.peakRss).toBeLessThan(384 * 1024 * 1024);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
}, 310_000);
