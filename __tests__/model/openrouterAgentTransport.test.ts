import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

it('preserves manual tool and archive safeguards through the real OpenRouter SDK HTTP boundary', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [path.join(__dirname, 'fixtures/openrouterAgentTransport.cjs'), process.cwd()], { timeout: 30_000 });
  expect(stdout).toContain('"contract":"real-sdk-loopback","assertions":"passed"');
}, 35_000);
