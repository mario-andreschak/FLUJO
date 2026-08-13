/* eslint-disable @typescript-eslint/no-require-imports -- exercise the CommonJS pre-Jest bootstrap modules directly. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  REQUIRED_TEST_ARTIFACTS,
  inspectLocalTestDependencies,
} = require('../../scripts/local-test-dependencies.cjs') as {
  REQUIRED_TEST_ARTIFACTS: ReadonlyArray<{
    name: string;
    lockKey: string;
    relativePath: string;
  }>;
  inspectLocalTestDependencies(root: string): {
    root: string;
    jestBin: string;
    issues: string[];
  };
};

const {
  jestArgsFromNpm,
  withoutForeignNodeModuleBins,
} = require('../../scripts/run-local-jest.cjs') as {
  jestArgsFromNpm(argv: string[], env: NodeJS.ProcessEnv): string[];
  withoutForeignNodeModuleBins(value: string, localBin: string): string;
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function createCompleteFixture(root: string): void {
  const packages: Record<string, { version: string; optional?: boolean }> = {};
  for (const artifact of REQUIRED_TEST_ARTIFACTS) {
    packages[artifact.lockKey] = { version: '1.0.0' };
    const artifactPath = path.join(root, artifact.relativePath);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '{}', 'utf8');
  }
  packages['node_modules/platform-only-package'] = { version: '1.0.0', optional: true };
  writeJson(path.join(root, 'package-lock.json'), { lockfileVersion: 3, packages });
  writeJson(path.join(root, 'node_modules', '.package-lock.json'), {
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(packages).filter(([, value]) => value.optional !== true),
    ),
  });
}

describe('local test dependency isolation', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-local-test-deps-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('accepts a lockfile-complete local install and ignores absent optional packages', () => {
    createCompleteFixture(tempRoot);

    const result = inspectLocalTestDependencies(tempRoot);

    expect(result.issues).toEqual([]);
    expect(result.jestBin).toBe(path.join(tempRoot, 'node_modules', 'jest', 'bin', 'jest.js'));
  });

  it('rejects an incomplete checkout even when its parent has a working Jest binary', () => {
    const checkout = path.join(tempRoot, 'nested', 'checkout');
    createCompleteFixture(checkout);
    fs.rmSync(path.join(checkout, 'node_modules', 'jest'), { recursive: true, force: true });
    const parentJest = path.join(tempRoot, 'node_modules', 'jest', 'bin', 'jest.js');
    fs.mkdirSync(path.dirname(parentJest), { recursive: true });
    fs.writeFileSync(parentJest, 'module.exports = {};', 'utf8');

    const result = inspectLocalTestDependencies(checkout);

    expect(result.issues).toContain('Jest is missing at node_modules/jest/bin/jest.js');
    expect(result.jestBin).not.toBe(parentJest);
  });

  it('reports missing and version-skewed packages from the installed inventory', () => {
    createCompleteFixture(tempRoot);
    const installedPath = path.join(tempRoot, 'node_modules', '.package-lock.json');
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    delete installed.packages['node_modules/mcp-stdio-oauth'];
    installed.packages['node_modules/next'].version = '0.0.0';
    writeJson(installedPath, installed);

    const result = inspectLocalTestDependencies(tempRoot);

    expect(result.issues.some((issue) => issue.includes('mcp-stdio-oauth'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('next (0.0.0 != 1.0.0)'))).toBe(true);
  });

  it('recovers runInBand when the PowerShell npm shim exposes it as config', () => {
    expect(jestArgsFromNpm(['a.test.ts'], { NODE_ENV: 'test', npm_config_runinband: 'true' }))
      .toEqual(['--runInBand', 'a.test.ts']);
    expect(jestArgsFromNpm(['--runInBand', 'a.test.ts'], { NODE_ENV: 'test', npm_config_runinband: 'true' }))
      .toEqual(['--runInBand', 'a.test.ts']);
    expect(jestArgsFromNpm(['a.test.ts'], { NODE_ENV: 'test', npm_config_runinband: 'false' }))
      .toEqual(['a.test.ts']);
  });

  it('removes ancestor node_modules bins from the child PATH', () => {
    const localBin = path.join(tempRoot, 'checkout', 'node_modules', '.bin');
    const foreignBin = path.join(tempRoot, 'node_modules', '.bin');
    const systemBin = path.join(tempRoot, 'system-bin');

    expect(withoutForeignNodeModuleBins(
      [foreignBin, systemBin, localBin].join(path.delimiter),
      localBin,
    ).split(path.delimiter)).toEqual([localBin, systemBin]);
  });
});
