import {
  buildWaveLookup,
  waveBucket,
  orderWaveGroups,
  WAVE_ADHOC_KEY,
  WAVE_ADHOC_LABEL,
  WAVE_ARCHIVED_KEY,
  WAVE_ARCHIVED_LABEL,
} from '@/utils/shared/waveGrouping';
import { groupItems, CardGroup } from '@/utils/shared/cardGrouping';
import type { WavesResponse, WaveChainNode } from '@/shared/types/waves/waves';

// Minimal chain-node factory: the lookup only reads executionId/name/flowName,
// the rest of WaveChainNode is filled with harmless defaults.
const node = (
  executionId: string,
  name: string,
  flowName?: string,
): WaveChainNode => ({
  executionId,
  name,
  enabled: true,
  flowId: `flow-${executionId}`,
  flowName,
  triggerKind: 'schedule',
  isRoot: false,
  timing: { mode: 'fixed' },
  subflows: [],
  emittedSignals: [],
});

const response = (waves: WavesResponse['waves']): WavesResponse => ({
  paused: false,
  generatedAt: '2026-07-20T00:00:00.000Z',
  waves,
  orphans: [],
});

const keys = (groups: CardGroup<unknown>[]) => groups.map((g) => g.key);
const labels = (groups: CardGroup<unknown>[]) => groups.map((g) => g.label);

describe('buildWaveLookup', () => {
  it('returns an empty map for null / undefined / empty input', () => {
    expect(buildWaveLookup(null).size).toBe(0);
    expect(buildWaveLookup(undefined).size).toBe(0);
    expect(buildWaveLookup(response([])).size).toBe(0);
  });

  it('maps every node in a wave to that wave id', () => {
    const waves = response([
      {
        id: 'wave-A',
        rootExecutionIds: ['exec-root'],
        nodes: [node('exec-root', 'Root'), node('exec-child', 'Child')],
        edges: [],
        hasCycle: false,
      },
    ]);
    const lookup = buildWaveLookup(waves);
    expect(lookup.get('exec-root')?.waveId).toBe('wave-A');
    expect(lookup.get('exec-child')?.waveId).toBe('wave-A');
  });

  it('labels a wave by its root node name, then flowName, then wave id', () => {
    const named = buildWaveLookup(
      response([
        { id: 'w1', rootExecutionIds: ['r'], nodes: [node('r', 'My Wave')], edges: [], hasCycle: false },
      ]),
    );
    expect(named.get('r')?.label).toBe('My Wave');

    const flowNamed = buildWaveLookup(
      response([
        { id: 'w2', rootExecutionIds: ['r'], nodes: [node('r', '', 'FlowName')], edges: [], hasCycle: false },
      ]),
    );
    expect(flowNamed.get('r')?.label).toBe('FlowName');

    const idFallback = buildWaveLookup(
      response([
        { id: 'w3', rootExecutionIds: ['r'], nodes: [node('r', '')], edges: [], hasCycle: false },
      ]),
    );
    expect(idFallback.get('r')?.label).toBe('w3');
  });

  it('falls back to the first node when the root id is absent from nodes', () => {
    const lookup = buildWaveLookup(
      response([
        { id: 'w', rootExecutionIds: ['missing'], nodes: [node('first', 'First')], edges: [], hasCycle: false },
      ]),
    );
    expect(lookup.get('first')?.label).toBe('First');
  });
});

describe('waveBucket', () => {
  const lookup = buildWaveLookup(
    response([
      { id: 'wave-A', rootExecutionIds: ['exec-1'], nodes: [node('exec-1', 'Alpha')], edges: [], hasCycle: false },
    ]),
  );

  it('buckets a null/undefined plannedExecutionId as Ad-hoc', () => {
    expect(waveBucket(null, lookup)).toEqual({ key: WAVE_ADHOC_KEY, label: WAVE_ADHOC_LABEL });
    expect(waveBucket(undefined, lookup)).toEqual({ key: WAVE_ADHOC_KEY, label: WAVE_ADHOC_LABEL });
  });

  it('buckets a known plannedExecutionId under its wave', () => {
    expect(waveBucket('exec-1', lookup)).toEqual({ key: 'wave:wave-A', label: 'Alpha' });
  });

  it('buckets an unknown plannedExecutionId as Archived', () => {
    expect(waveBucket('exec-gone', lookup)).toEqual({
      key: WAVE_ARCHIVED_KEY,
      label: WAVE_ARCHIVED_LABEL,
    });
  });
});

describe('orderWaveGroups', () => {
  it('moves Ad-hoc and Archived buckets to the end, preserving other order', () => {
    const groups: CardGroup<number>[] = [
      { key: WAVE_ADHOC_KEY, label: WAVE_ADHOC_LABEL, items: [1] },
      { key: 'wave:wave-B', label: 'B', items: [2] },
      { key: WAVE_ARCHIVED_KEY, label: WAVE_ARCHIVED_LABEL, items: [3] },
      { key: 'wave:wave-A', label: 'A', items: [4] },
    ];
    expect(keys(orderWaveGroups(groups))).toEqual([
      'wave:wave-B',
      'wave:wave-A',
      WAVE_ADHOC_KEY,
      WAVE_ARCHIVED_KEY,
    ]);
  });
});

describe('wave grouping integration (groupItems + waveBucket + orderWaveGroups)', () => {
  interface Conv {
    id: string;
    plannedExecutionId?: string | null;
  }

  it('buckets conversations by wave with Ad-hoc/Archived last', () => {
    const lookup = buildWaveLookup(
      response([
        { id: 'wA', rootExecutionIds: ['e1'], nodes: [node('e1', 'Wave A')], edges: [], hasCycle: false },
        { id: 'wB', rootExecutionIds: ['e2'], nodes: [node('e2', 'Wave B')], edges: [], hasCycle: false },
      ]),
    );
    // Ordered most-recent-first by the caller; Ad-hoc appears first here but
    // must be pushed last by orderWaveGroups.
    const convs: Conv[] = [
      { id: 'c1', plannedExecutionId: null }, // Ad-hoc
      { id: 'c2', plannedExecutionId: 'e2' }, // Wave B
      { id: 'c3', plannedExecutionId: 'e1' }, // Wave A
      { id: 'c4', plannedExecutionId: 'gone' }, // Archived
      { id: 'c5', plannedExecutionId: 'e2' }, // Wave B
    ];

    const grouped = orderWaveGroups(
      groupItems(convs, (c) => waveBucket(c.plannedExecutionId, lookup)),
    );

    expect(labels(grouped)).toEqual([
      'Wave B',
      'Wave A',
      WAVE_ADHOC_LABEL,
      WAVE_ARCHIVED_LABEL,
    ]);
    const waveB = grouped.find((g) => g.key === 'wave:wB')!;
    expect(waveB.items.map((c) => c.id)).toEqual(['c2', 'c5']);
  });
});
