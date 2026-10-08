import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureRuntimeEnvironment } from './browser-environment.mjs';

test('packaged candidate runtime settings use the owned profile instead of the user npm dotenv fallback', () => {
  const environment = fixtureRuntimeEnvironment({
    dataDir: '/owned/disposable-profile', baseURL: 'http://127.0.0.1:9311',
    fixtureUrl: 'http://127.0.0.1:9312', sandboxPort: 9313,
    hostEnvironment: { PATH: '/system/path', SYSTEMROOT: '/system/root',
      FLUJO_RUNTIME_ENV_DIR: '/synthetic-unowned-user-config',
      FLUJO_DATA_DIR: '/synthetic-unowned-profile', FLUJO_OWNER_TOKEN: 'synthetic-owner',
      OPENAI_API_KEY: 'synthetic-key', NODE_OPTIONS: '--synthetic-injection', NODE_PATH: '/synthetic-modules' },
  });
  assert.equal(environment.FLUJO_RUNTIME_ENV_DIR, '/owned/disposable-profile');
  assert.equal(environment.FLUJO_DATA_DIR, '/owned/disposable-profile');
  assert.equal(environment.PATH, '/system/path');
  for (const key of ['FLUJO_OWNER_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.equal(Object.hasOwn(environment, key), false);
  }
});
