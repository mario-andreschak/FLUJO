import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let testRoot = '';

jest.mock('@/utils/paths', () => ({
  getAppDir: () => testRoot,
  getInstallMode: () => 'git',
}));

import {
  readRuntimeEnvironmentFile,
  runtimeEnvironmentFile,
  writeRuntimeEnvironmentFile,
} from '@/backend/services/runtimeEnvironment';

describe('runtime environment settings file', () => {
  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runtime-env-'));
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('writes and reads quoted values while preserving unmanaged dotenv content', async () => {
    await fs.writeFile(runtimeEnvironmentFile(), 'UNMANAGED=value\n# keep this\n', 'utf8');

    await writeRuntimeEnvironmentFile({
      FLUJO_PORT: '4310',
      FLUJO_EXTRA_LOCAL_HOSTS: 'host one,host-two',
    });

    const contents = await fs.readFile(runtimeEnvironmentFile(), 'utf8');
    expect(contents).toContain('UNMANAGED=value');
    expect(contents).toContain('# keep this');
    expect(contents).toContain('FLUJO_PORT="4310"');
    expect(contents).toContain('FLUJO_EXTRA_LOCAL_HOSTS="host one,host-two"');
    await expect(readRuntimeEnvironmentFile()).resolves.toMatchObject({
      configured: {
        FLUJO_PORT: '4310',
        FLUJO_EXTRA_LOCAL_HOSTS: 'host one,host-two',
      },
    });
  });

  it('removes blank managed values and rejects unknown names', async () => {
    await writeRuntimeEnvironmentFile({ FLUJO_PORT: '4310' });
    await writeRuntimeEnvironmentFile({ FLUJO_PORT: '' });
    await expect(readRuntimeEnvironmentFile()).resolves.toMatchObject({ configured: {} });
    await expect(writeRuntimeEnvironmentFile({ PATH: 'nope' })).rejects.toThrow(
      'Unsupported environment variable: PATH',
    );
  });

  it('loads .env.local before launcher-level values are read', async () => {
    await fs.writeFile(path.join(testRoot, '.env.local'), 'FLUJO_PORT=4312\n', 'utf8');
    const launcherUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'launch-next.mjs')).href;
    const program = `
      import { loadLaunchEnvironment } from ${JSON.stringify(launcherUrl)};
      loadLaunchEnvironment(process.argv[1], false);
      process.stdout.write(process.env.FLUJO_PORT || 'missing');
    `;
    const cleanEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name, value]) => name !== 'FLUJO_PORT' && value !== undefined),
      ),
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv;
    expect(execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', program, testRoot],
      { cwd: process.cwd(), encoding: 'utf8', env: cleanEnv },
    )).toBe('4312');
  });
});
