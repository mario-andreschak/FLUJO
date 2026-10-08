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

  const writeWorkspaceMarker = (version = 2) => {
    fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'workspaces', '.workspace-layout.json'),
      JSON.stringify({
        version,
        completedAt: new Date().toISOString(),
        defaultWorkspace: 'default-workspace',
        subtrees: {},
        ...(version === 2
          ? {
              transactionId: '00000000-0000-4000-8000-000000000000',
              manifestDigest: '0'.repeat(64),
            }
          : {}),
      }),
    );
  };

  const writeWorkspaceSettings = (network: Record<string, unknown>) => {
    const dbDir = path.join(dataDir, 'workspaces', 'default-workspace', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(
      path.join(dbDir, 'speech_settings.json'),
      JSON.stringify({ network }),
    );
  };

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
      args: [
        'start',
        '-p',
        '4200',
        '-H',
        process.platform === 'win32' ? '::' : '0.0.0.0',
      ],
    });
  });

  it('prefers default-workspace settings during a pre-marker upgrade', () => {
    fs.writeFileSync(
      path.join(dataDir, 'db', 'speech_settings.json'),
      JSON.stringify({ network: { exposure: 'public' } }),
    );
    writeWorkspaceSettings({ exposure: 'network' });

    expect(evaluate({ FLUJO_DATA_DIR: dataDir })).toMatchObject({
      mode: 'network',
      source: 'settings',
    });
  });

  it('never falls back to a stale root setting after a durable marker', () => {
    fs.writeFileSync(
      path.join(dataDir, 'db', 'speech_settings.json'),
      JSON.stringify({ network: { exposure: 'public' } }),
    );
    writeWorkspaceMarker();

    expect(evaluate({ FLUJO_DATA_DIR: dataDir })).toMatchObject({
      mode: 'localhost',
      source: 'default',
    });
  });

  it.each([
    ['corrupt', '{not-json'],
    ['future', JSON.stringify({
      version: 999,
      completedAt: new Date().toISOString(),
      defaultWorkspace: 'default-workspace',
      subtrees: {},
    })],
  ])('fails closed for a %s workspace marker', (_label, marker) => {
    fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'workspaces', '.workspace-layout.json'), marker);
    fs.writeFileSync(
      path.join(dataDir, 'db', 'speech_settings.json'),
      JSON.stringify({ network: { exposure: 'public' } }),
    );

    expect(evaluate({
      FLUJO_DATA_DIR: dataDir,
      FLUJO_EXTRA_LOCAL_HOSTS: '.tenants.internal',
    })).toMatchObject({
      mode: 'localhost',
      source: 'default',
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
