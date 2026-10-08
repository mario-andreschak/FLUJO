import { render, screen } from '@testing-library/react';
import SubflowLaneChip from '@/frontend/components/Chat/SubflowLaneChip';

describe('SubflowLaneChip', () => {
  const result = {
    subflowId: 'research',
    subflowName: 'Research',
    laneTitle: 'Lane A',
    laneIndex: 0,
    laneCount: 3,
    status: 'completed' as const,
  };

  it('renders a lane title and position', () => {
    render(<SubflowLaneChip result={result} />);

    expect(screen.getByTestId('subflow-lane-chip')).toHaveTextContent('Lane A (1/3)');
  });

  it('falls back from lane title to subflow name, then lane number', () => {
    const { rerender } = render(<SubflowLaneChip result={{ ...result, laneTitle: undefined }} />);
    expect(screen.getByTestId('subflow-lane-chip')).toHaveTextContent('Research (1/3)');

    rerender(<SubflowLaneChip result={{ ...result, laneTitle: undefined, subflowName: undefined }} />);
    expect(screen.getByTestId('subflow-lane-chip')).toHaveTextContent('Lane 1 (1/3)');
  });

  it('uses the error chip colour for failed lanes', () => {
    render(<SubflowLaneChip result={{ ...result, status: 'error' }} />);

    expect(screen.getByTestId('subflow-lane-chip')).toHaveClass('MuiChip-colorError');
  });
});
