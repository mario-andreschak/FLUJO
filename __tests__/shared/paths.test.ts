/**
 * Unit tests for the app-dir / data-dir / install-mode resolver (src/utils/paths.ts).
 *
 * This module is the seam that lets the npm package (#59) and the Docker image
 * (#57) relocate user data and report the right self-update behavior, while a
 * plain git checkout is completely unchanged. Contract points covered:
 *  - getDataDir() defaults to the app dir (process.cwd()) so a git checkout keeps
 *    data in the repo, honors FLUJO_DATA_DIR otherwise, and lets the internal
 *    FLUJO_PARENT_DATA_DIR marker recover the parent root at child boundaries
 *  - getInstallMode() maps FLUJO_CONTAINER -> 'container', FLUJO_NPM -> 'npm',
 *    and neither -> 'git', with container taking precedence
 */
import path from 'path';
import { getAppDir, getDataDir, getInstallMode } from '@/utils/paths';

describe('utils/paths', () => {
  const ORIGINAL = {
    parentDataDir: process.env.FLUJO_PARENT_DATA_DIR,
    dataDir: process.env.FLUJO_DATA_DIR,
    container: process.env.FLUJO_CONTAINER,
    npm: process.env.FLUJO_NPM,
  };

  beforeEach(() => {
    delete process.env.FLUJO_PARENT_DATA_DIR;
  });

  afterEach(() => {
    // Restore so tests can't leak env into each other or the rest of the suite.
    for (const [key, value] of [
      ['FLUJO_PARENT_DATA_DIR', ORIGINAL.parentDataDir],
      ['FLUJO_DATA_DIR', ORIGINAL.dataDir],
      ['FLUJO_CONTAINER', ORIGINAL.container],
      ['FLUJO_NPM', ORIGINAL.npm],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('getDataDir', () => {
    it('defaults to the app dir (process.cwd()) when FLUJO_DATA_DIR is unset', () => {
      delete process.env.FLUJO_DATA_DIR;
      expect(getDataDir()).toBe(process.cwd());
      expect(getDataDir()).toBe(getAppDir());
    });

    it('treats an empty/whitespace FLUJO_DATA_DIR as unset', () => {
      process.env.FLUJO_DATA_DIR = '   ';
      expect(getDataDir()).toBe(process.cwd());
    });

    it('honors FLUJO_DATA_DIR and resolves it to an absolute path', () => {
      const custom = path.join(process.cwd(), 'tmp-data-dir');
      process.env.FLUJO_DATA_DIR = custom;
      expect(getDataDir()).toBe(path.resolve(custom));
    });

    it('resolves a relative FLUJO_DATA_DIR against the cwd', () => {
      process.env.FLUJO_DATA_DIR = 'relative-data';
      expect(getDataDir()).toBe(path.resolve('relative-data'));
      expect(path.isAbsolute(getDataDir())).toBe(true);
    });

    it('prefers the parent marker when FLUJO_DATA_DIR names a selected workspace', () => {
      process.env.FLUJO_PARENT_DATA_DIR = 'parent-data';
      process.env.FLUJO_DATA_DIR = path.join('parent-data', 'workspaces', 'research');
      expect(getDataDir()).toBe(path.resolve('parent-data'));
    });

    it('treats an empty parent marker as absent', () => {
      process.env.FLUJO_PARENT_DATA_DIR = '   ';
      process.env.FLUJO_DATA_DIR = 'configured-data';
      expect(getDataDir()).toBe(path.resolve('configured-data'));
    });
  });

  describe('getInstallMode', () => {
    it("returns 'git' when neither container nor npm flags are set", () => {
      delete process.env.FLUJO_CONTAINER;
      delete process.env.FLUJO_NPM;
      expect(getInstallMode()).toBe('git');
    });

    it("returns 'container' when FLUJO_CONTAINER is set", () => {
      process.env.FLUJO_CONTAINER = '1';
      delete process.env.FLUJO_NPM;
      expect(getInstallMode()).toBe('container');
    });

    it("returns 'npm' when only FLUJO_NPM is set", () => {
      delete process.env.FLUJO_CONTAINER;
      process.env.FLUJO_NPM = '1';
      expect(getInstallMode()).toBe('npm');
    });

    it('prefers container over npm when both are set', () => {
      process.env.FLUJO_CONTAINER = '1';
      process.env.FLUJO_NPM = '1';
      expect(getInstallMode()).toBe('container');
    });
  });
});
