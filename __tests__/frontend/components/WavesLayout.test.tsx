import { render, screen } from '@testing-library/react';

const mockLoad = jest.fn();
const mockPlaygroundCanvas = jest.fn((_props: unknown) => <div data-testid="playground-canvas" />);

jest.mock('@/frontend/services/automationMap', () => ({
  automationMapService: { load: () => mockLoad() },
}));

jest.mock('@/frontend/hooks/useUiPreference', () => ({
  useWorkspaceUiPreference: (_key: string, initial: unknown) => [initial, jest.fn()],
}));

jest.mock('@/frontend/components/Waves/PlaygroundCanvas', () => ({
  __esModule: true,
  default: (props: unknown) => mockPlaygroundCanvas(props),
}));

jest.mock('@/frontend/components/Waves/DayView', () => ({
  __esModule: true,
  default: () => <div data-testid="day-view" />,
}));

import WavesManager from '@/frontend/components/Waves';

describe('Waves full-page layout (#325)', () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockPlaygroundCanvas.mockClear();
  });

  it('lets the unified Playground canvas fill the constrained manager height', async () => {
    const response = {
      paused: false,
      generatedAt: '2026-08-14T12:00:00.000Z',
      packages: [],
      flows: [
        {
          flow: { id: 'flow-1', name: 'Morning digest', nodes: [], edges: [] },
          packageNames: [],
          executionIds: ['trigger-1'],
          waveIds: ['wave-1'],
          componentIds: ['component-1'],
        },
      ],
      executions: [],
      relations: [],
      waves: [
        {
          id: 'wave-1',
          rootExecutionIds: ['trigger-1'],
          executionIds: ['trigger-1'],
          flowIds: ['flow-1'],
          relationIds: [],
          hasCycle: false,
        },
      ],
      components: [],
      orphanExecutionIds: [],
    };
    mockLoad.mockResolvedValue(response);

    render(
      <WavesManager
        height={{ xs: 'calc(100dvh - 56px)', sm: 'calc(100dvh - 64px)' }}
      />,
    );

    expect(await screen.findByTestId('playground-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('waves-playground')).toBeInTheDocument();
    const lastCanvasCall = mockPlaygroundCanvas.mock.calls[mockPlaygroundCanvas.mock.calls.length - 1];
    expect(lastCanvasCall?.[0]).toEqual(expect.objectContaining({
      data: response,
      mode: 'simple',
      activeWaveId: null,
    }));
  });
});
