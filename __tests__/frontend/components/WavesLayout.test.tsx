import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockLoad = jest.fn();
let mockSavedView: string | undefined = 'playground';
const mockPlaygroundCanvas = jest.fn((_props: unknown) => <div data-testid="playground-canvas" />);

jest.mock('@/frontend/services/automationMap', () => ({
  automationMapService: { load: () => mockLoad() },
}));

jest.mock('@/frontend/hooks/useUiPreference', () => ({
  useWorkspaceUiPreference: (key: string, initial: unknown) => [key === 'flujo-ui:waves:view' ? mockSavedView ?? initial : initial, jest.fn()],
}));

jest.mock('@/frontend/components/Waves/FactoryObservatoryPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="factory-observatory" />,
}));

jest.mock('@/frontend/components/Waves/PlaygroundCanvas', () => ({
  __esModule: true,
  default: (props: unknown) => mockPlaygroundCanvas(props),
}));

import WavesManager from '@/frontend/components/Waves';

describe('Waves full-page layout (#325)', () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockPlaygroundCanvas.mockClear();
    mockSavedView = 'playground';
  });

  it('opens the calendar with date guidance when no view has been saved', async () => {
    mockSavedView = undefined;
    mockLoad.mockResolvedValue({
      paused: false, generatedAt: '2026-10-10T12:00:00.000Z',
      packages: [], flows: [], executions: [], relations: [], waves: [], components: [], orphanExecutionIds: [],
    });
    render(<WavesManager />);
    expect(await screen.findByTestId('waves-day-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('See what’s planned for your day. Pick a date to explore.')).toBeInTheDocument();
    expect(screen.queryByTestId('playground-canvas')).not.toBeInTheDocument();
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
    expect(screen.getByText('See how your automations connect. Choose Expert for more detail.')).toBeInTheDocument();
    const lastCanvasCall = mockPlaygroundCanvas.mock.calls[mockPlaygroundCanvas.mock.calls.length - 1];
    expect(lastCanvasCall?.[0]).toEqual(expect.objectContaining({
      data: response,
      mode: 'simple',
      activeWaveId: null,
    }));
  });

  it('does not load or arm the automation map when the saved view is FACTORY', async () => {
    mockSavedView = 'factory';
    render(<WavesManager />);
    expect(await screen.findByTestId('factory-observatory')).toBeInTheDocument();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it.each(['day', 'playground'])('warns after a failed %s refresh and clears the warning on recovery without resetting the view', async (view) => {
    jest.useFakeTimers();
    mockSavedView = view;
    const response = {
      paused: false, generatedAt: '2026-10-10T12:00:00.000Z',
      packages: [], flows: [], executions: [], relations: [], waves: [], components: [], orphanExecutionIds: [],
    };
    const recovered = { ...response, paused: true, generatedAt: '2026-10-10T12:01:00.000Z' };
    mockLoad.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(recovered);
    const rendered = render(<WavesManager />);
    try {
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      const initialView = screen.getByTestId(view === 'day' ? 'waves-day-view' : 'waves-playground');
      let selectedDay: string | null = null;
      let timeline: HTMLElement | null = null;
      if (view === 'day') {
        fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
        const grid = within(initialView).getByRole('grid', { hidden: true });
        selectedDay = within(grid).getByRole('gridcell', { selected: true, hidden: true }).querySelector('button')!.getAttribute('aria-label');
        timeline = screen.getByRole('region', { hidden: true });
        timeline.scrollTop = 433;
      }

      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh. These details may be out of date.");
      expect(screen.getByTestId(view === 'day' ? 'waves-day-view' : 'waves-playground')).toBe(initialView);
      if (view === 'day') {
        const grid = within(initialView).getByRole('grid', { hidden: true });
        expect(within(grid).getByRole('gridcell', { selected: true, hidden: true }).querySelector('button')).toHaveAttribute('aria-label', selectedDay);
        expect(timeline!.scrollTop).toBe(433);
      } else {
        expect(mockPlaygroundCanvas.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ data: response }));
      }

      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockLoad).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId(view === 'day' ? 'waves-day-view' : 'waves-playground')).toBe(initialView);
      if (view === 'day') {
        const grid = within(initialView).getByRole('grid', { hidden: true });
        expect(within(grid).getByRole('gridcell', { selected: true, hidden: true }).querySelector('button')).toHaveAttribute('aria-label', selectedDay);
        expect(timeline!.scrollTop).toBe(433);
        expect(within(initialView).getByText('Scheduler paused')).toBeInTheDocument();
      } else {
        expect(mockPlaygroundCanvas.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ data: recovered }));
      }
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });
});
