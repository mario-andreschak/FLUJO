import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'exposure-mode.mjs')).href;

function evaluate(env: Record<string, string>): {
  mode: string;
  source: string;
  args: string[];
} {
  const program = `
    import { applyExposureRuntimeEnv, withExposureHostname } from ${JSON.stringify(moduleUrl)};
    const env = applyExposureRuntimeEnv(JSON.parse(process.argv[1]), process.cwd());
    process.stdout.write(JSON.stringify({
      mode: env.FLUJO_EXPOSURE_MODE,
      source: env.FLUJO_EXPOSURE_MODE_SOURCE,
      args: withExposureHostname(['start', '-p', '4200'], env),
    }));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', program, JSON.stringify(env)],
    { cwd: process.cwd(), encoding: 'utf8' },
  ));
}

describe('exposure-aware launcher', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-exposure-'));
    fs.mkdirSync(path.join(dataDir, 'db'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses the secure loopback default', () => {
    expect(evaluate({ FLUJO_DATA_DIR: dataDir })).toMatchObject({
      mode: 'localhost',
      source: 'default',
      args: ['start', '-p', '4200', '-H', '127.0.0.1'],
    });
  });

  it('reads the one persisted Settings choice and widens the bind address', () => {
    fs.writeFileSync(
      path.join(dataDir, 'db', 'speech_settings.json'),
      JSON.stringify({ speech: { enabled: true }, network: { exposure: 'network' } }),
    );

    expect(evaluate({ FLUJO_DATA_DIR: dataDir })).toMatchObject({
      mode: 'network',
      source: 'settings',
      args: ['start', '-p', '4200', '-H', '0.0.0.0'],
    });
  });

  it('migrates old hosted configuration only when no Settings choice exists', () => {
    expect(evaluate({
      FLUJO_DATA_DIR: dataDir,
      FLUJO_EXTRA_LOCAL_HOSTS: '.tenants.internal',
    })).toMatchObject({
      mode: 'network',
      source: 'legacy',
    });
  });
});

