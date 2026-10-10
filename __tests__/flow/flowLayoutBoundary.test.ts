import path from 'node:path';
import { computeAutoLayout as sharedAuto } from '@/shared/utils/flowLayout/autoLayout';
import { computeTidyLayout as sharedTidy } from '@/shared/utils/flowLayout/tidyLayout';
import * as sharedGeometry from '@/shared/utils/flowLayout/layoutGeometry';
import { computeAutoLayout as frontendAuto } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout';
import { computeTidyLayout as frontendTidy } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/tidyLayout';
import * as frontendGeometry from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/layoutGeometry';

const { runLayoutProcess } = require('./fixtures/layoutProcessHarness.cjs');
const source = path.resolve(__dirname, '../../src/shared/utils/flowLayout');

describe('shared layout module contract', () => {
  it('keeps existing frontend entry points on the same functions and fallback objects', () => {
    expect(frontendAuto).toBe(sharedAuto);
    expect(frontendTidy).toBe(sharedTidy);
    expect(frontendGeometry).toEqual(sharedGeometry);
    expect(frontendGeometry.NODE_SIZE_FALLBACK).toBe(sharedGeometry.NODE_SIZE_FALLBACK);
    expect(frontendGeometry.DEFAULT_NODE_SIZE).toBe(sharedGeometry.DEFAULT_NODE_SIZE);
  });

  it('runs frozen graph fixtures in a child process with only the geometry modules', () => {
    const result = runLayoutProcess(source);
    expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({
      status: 0, error: undefined, stderr: '',
    });
    expect(result.observation.trace).toHaveLength(12);
    expect(new Set(result.observation.loaded)).toEqual(new Set([
      'autoLayout.js', 'layoutGeometry.js', 'tidyLayout.js',
    ]));
    // Preserve the observed baseline limitation; this extraction is not a
    // behavioral fix for tidy mode's coincident-satellite overlap.
    expect(result.observation.trace.filter((entry: { overlaps: boolean }) => entry.overlaps)
      .map((entry: { fixture: string; mode: string }) => [entry.fixture, entry.mode]))
      .toEqual([['branch-with-satellites', 'tidy'], ['orphan-satellite', 'tidy']]);
  });

  it('rejects an added runtime dependency at the compiled module boundary', () => {
    const result = runLayoutProcess(source, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unexpected layout runtime dependency: node:fs');
    expect(result.observation).toBeUndefined();
  });
});
