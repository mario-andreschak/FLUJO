import { render, screen } from '@testing-library/react';

const mockList = jest.fn();
const mockWaveCanvas = jest.fn((_props: unknown) => <div data-testid="wave-canvas" />);

jest.mock('@/frontend/services/waves', () => ({
  wavesService: { list: () => mockList() },
}));

jest.mock('@/frontend/hooks/useUiPreference', () => ({
  useUiPreference: () => [null, jest.fn()],
}));

jest.mock('@/frontend/hooks/useScrollRestoration', () => ({
  useScrollRestoration: () => ({
    ref: { current: null },
    showBackToTop: false,
    scrollToTop: jest.fn(),
  }),
}));

jest.mock('@/frontend/components/shared/BackToTopButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/components/Waves/WaveCanvas', () => ({
  __esModule: true,
  default: (props: unknown) => mockWaveCanvas(props),
}));

import WavesManager from '@/frontend/components/Waves';

describe('Waves full-page layout (#325)', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockWaveCanvas.mockClear();
  });

  it('lets the selected WaveCanvas fill the constrained manager height', async () => {
    mockList.mockResolvedValue({
      paused: false,
      orphans: [],
      waves: [
        {
          id: 'wave-1',
          rootExecutionIds: ['trigger-1'],
          hasCycle: false,
          nodes: [
            {
              executionId: 'trigger-1',
              name: 'Morning digest',
              timing: { mode: 'event' },
            },
          ],
        },
      ],
    });

    render(
      <WavesManager
        height={{ xs: 'calc(100dvh - 56px)', sm: 'calc(100dvh - 64px)' }}
      />,
    );

    expect(await screen.findByTestId('wave-canvas')).toBeInTheDocument();
    const lastCanvasCall = mockWaveCanvas.mock.calls[mockWaveCanvas.mock.calls.length - 1];
    expect(lastCanvasCall?.[0]).toEqual(expect.objectContaining({ height: '100%' }));
  });
});
