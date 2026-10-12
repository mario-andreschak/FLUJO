import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockLoad = jest.fn();
let mockSavedView: string | undefined = 'playground';
const mockPlaygroundCanvas = jest.fn((_props: unknown) => <div data-testid="playground-canvas" />);

const emptyMap = {
  paused: false, generatedAt: '2026-10-11T23:00:00.000Z',
  packages: [], flows: [], executions: [], relations: [], waves: [], components: [], orphanExecutionIds: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

jest.mock('@/frontend/services/automationMap', () => ({
  automationMapService: { load: (signal?: AbortSignal) => mockLoad(signal) },
}));

jest.mock('@/frontend/hooks/useUiPreference', () => ({
  useWorkspaceUiPreference: (key: string, initial: unknown) =>
    jest.requireActual<typeof import('react')>('react').useState(key === 'flujo-ui:waves:view' ? mockSavedView ?? initial : initial),
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

  it.each(['wave', 'execution', 'playground', 'factory'])('keeps the selected calendar date after visiting %s', async (destination) => {
    mockSavedView = 'day';
    const response = {
      paused: false, generatedAt: new Date().toISOString(),
      packages: [], flows: [], relations: [], components: [], orphanExecutionIds: [],
      executions: [{
        executionId: 'report', name: 'Morning report', flowId: 'flow', enabled: true,
        packageNames: [], trigger: { type: 'schedule', cron: '0 12 * * *' },
        triggerKind: 'schedule', status: { armed: true, running: false },
        lastRun: null, isRoot: true, waveIds: destination === 'wave' ? ['wave-1'] : [],
      }],
      waves: destination === 'wave' ? [{
        id: 'wave-1', rootExecutionIds: ['report'], executionIds: ['report'],
        flowIds: ['flow'], relationIds: [], hasCycle: false,
      }] : [],
    };
    mockLoad.mockResolvedValue(response);
    render(<WavesManager />);
    const calendar = await screen.findByTestId('waves-day-view');
    const selectedDay = () => within(within(screen.getByTestId('waves-day-view')).getByRole('grid', { hidden: true }))
      .getByRole('gridcell', { selected: true, hidden: true }).querySelector('button')!.getAttribute('aria-label');
    const today = selectedDay();
    fireEvent.click(within(calendar).getByRole('button', { name: 'Next day' }));
    const nextDay = selectedDay();
    expect(nextDay).not.toBe(today);
    if (destination === 'wave' || destination === 'execution') {
      fireEvent.click(screen.getByRole('button', { name: /, Morning report, Run$/ }));
      expect(await screen.findByTestId('playground-canvas')).toBeInTheDocument();
      expect(mockPlaygroundCanvas.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        activeWaveId: destination === 'wave' ? 'wave-1' : null,
      }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: destination === 'factory' ? 'FACTORY swarm' : 'Playground' }));
      expect(await screen.findByTestId(destination === 'factory' ? 'factory-observatory' : 'playground-canvas')).toBeInTheDocument();
    }
    expect(screen.queryByTestId('waves-day-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    await screen.findByTestId('waves-day-view');
    expect(selectedDay()).toBe(nextDay);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(selectedDay()).toBe(today);
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

  it('lets a slow load finish without overlapping or discarding it at the next poll', async () => {
    jest.useFakeTimers();
    const slow = deferred<typeof emptyMap>();
    const latest = { ...emptyMap, paused: true, generatedAt: '2026-10-11T23:02:00.000Z' };
    mockLoad.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(latest);
    const rendered = render(<WavesManager />);
    try {
      await act(async () => { await jest.advanceTimersByTimeAsync(45_000); });
      expect(mockLoad).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toBeInTheDocument();
      await act(async () => { slow.resolve(emptyMap); });
      expect(mockPlaygroundCanvas.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ data: emptyMap }));
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(mockPlaygroundCanvas.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ data: latest }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it.each(['success', 'failure'])('ignores a departed request %s after receiving the new view’s map', async (outcome) => {
    const departed = deferred<typeof emptyMap>();
    const latest = { ...emptyMap, paused: true, generatedAt: '2026-10-11T23:02:00.000Z' };
    mockLoad.mockReturnValueOnce(departed.promise).mockResolvedValueOnce(latest);
    render(<WavesManager />);
    const previousSignal = mockLoad.mock.calls[0][0] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(previousSignal.aborted).toBe(true);
    const calendar = await screen.findByTestId('waves-day-view');
    expect(within(calendar).getByText('Scheduler paused')).toBeInTheDocument();
    await act(async () => {
      if (outcome === 'success') departed.resolve(emptyMap);
      else departed.reject(new Error('Departed request went offline'));
    });
    expect(within(calendar).getByText('Scheduler paused')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['initial', 'background'])('makes a timed-out %s load retryable without overlapping polls', async (kind) => {
    jest.useFakeTimers();
    mockSavedView = 'day';
    if (kind === 'background') mockLoad.mockResolvedValueOnce(emptyMap);
    mockLoad.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    })).mockResolvedValue(emptyMap);
    const rendered = render(<WavesManager />);
    try {
      await act(async () => { await Promise.resolve(); });
      const calendar = kind === 'background' ? screen.getByTestId('waves-day-view') : null;
      if (kind === 'background') await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      const beforeTimeout = kind === 'background' ? 2 : 1;
      await act(async () => { await jest.advanceTimersByTimeAsync(59_999); });
      expect(mockLoad).toHaveBeenCalledTimes(beforeTimeout);
      await act(async () => { await jest.advanceTimersByTimeAsync(1); });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('waves-day-view')).toBeInTheDocument();
      if (calendar) expect(screen.getByTestId('waves-day-view')).toBe(calendar);
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it('retries a stale calendar immediately and keeps the selected date and scroll through repeated failures', async () => {
    jest.useFakeTimers();
    mockSavedView = 'day';
    const retry = deferred<typeof emptyMap>();
    mockLoad.mockResolvedValueOnce(emptyMap).mockRejectedValueOnce(new Error('Offline'))
      .mockReturnValueOnce(retry.promise).mockResolvedValue({ ...emptyMap, paused: true });
    const rendered = render(<WavesManager />);
    try {
      await act(async () => { await Promise.resolve(); });
      const calendar = screen.getByTestId('waves-day-view');
      fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
      const selectedDay = () => within(within(calendar).getByRole('grid', { hidden: true }))
        .getByRole('gridcell', { selected: true, hidden: true }).querySelector('button')!.getAttribute('aria-label');
      const chosenDate = selectedDay();
      const timeline = screen.getByRole('region', { hidden: true });
      timeline.scrollTop = 433;
      await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(mockLoad).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('waves-day-view')).toBe(calendar);
      expect(selectedDay()).toBe(chosenDate);
      expect(timeline.scrollTop).toBe(433);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent('Refreshing');
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(mockLoad).toHaveBeenCalledTimes(3);
      await act(async () => { retry.reject(new Error('Still offline')); });
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('waves-day-view')).toBe(calendar);
      expect(selectedDay()).toBe(chosenDate);
      expect(timeline.scrollTop).toBe(433);
      expect(within(calendar).getByText('Scheduler paused')).toBeInTheDocument();
    } finally {
      rendered.unmount();
      jest.useRealTimers();
    }
  });

  it('recovers an initial calendar failure with a labelled loading state and a retry', async () => {
    mockSavedView = 'day';
    const retry = deferred<typeof emptyMap>();
    mockLoad.mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(retry.promise);
    render(<WavesManager />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your calendar. Try again.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading your calendar');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { retry.resolve(emptyMap); });
    expect(screen.getByTestId('waves-day-view')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('discards a pending map %s when leaving the view', async (outcome) => {
    const departed = deferred<typeof emptyMap>();
    const returning = deferred<typeof emptyMap>();
    mockLoad.mockReturnValueOnce(departed.promise).mockReturnValueOnce(returning.promise);
    render(<WavesManager />);
    fireEvent.click(screen.getByRole('button', { name: 'FACTORY swarm' }));
    await act(async () => {
      if (outcome === 'success') departed.resolve(emptyMap);
      else departed.reject(new Error('Departed view is offline'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(screen.queryByTestId('waves-day-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your calendar');
    await act(async () => { returning.resolve(emptyMap); });
    expect(screen.getByTestId('waves-day-view')).toBeInTheDocument();
  });
});
