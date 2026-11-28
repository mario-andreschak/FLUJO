import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cappedNodeOptions, hasProductionBuild, startProductionFlujo } from './production.mjs';

test('caps the heap at 4 GB and keeps the other Node options', () => {
  assert.equal(cappedNodeOptions(''), '--max-old-space-size=4096');
  assert.equal(cappedNodeOptions(' --use-system-ca '), '--use-system-ca --max-old-space-size=4096');
  assert.equal(cappedNodeOptions('--max-old-space-size=2048'), '--max-old-space-size=2048');
});

test('asks for "npm run build" instead of starting without a production build', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flujo-journey-root-'));
  try {
    assert.equal(hasProductionBuild(root), false);
    await assert.rejects(startProductionFlujo({ root, logFile: path.join(root, 'flujo.log'), log: () => {} }), /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
