import { fireEvent, render, screen } from '@testing-library/react';
import ContextMenu from '@/frontend/components/Flow/FlowManager/FlowBuilder/ContextMenu';

describe('FlowBuilder ContextMenu Process conversion', () => {
  const baseProps = {
    open: true,
    position: { x: 20, y: 20 },
    onClose: jest.fn(),
    onDelete: jest.fn(),
    onEditProperties: jest.fn(),
    nodeId: 'process',
  };

  beforeEach(() => jest.clearAllMocks());

  it('shows the conversion action when Canvas marks the target as an eligible Process', () => {
    const onConvertToSubflow = jest.fn();
    render(<ContextMenu {...baseProps} onConvertToSubflow={onConvertToSubflow} />);

    fireEvent.click(screen.getByText('Convert to subflow'));

    expect(onConvertToSubflow).toHaveBeenCalledTimes(1);
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not show the action for nodes without a conversion callback', () => {
    render(<ContextMenu {...baseProps} />);
    expect(screen.queryByText('Convert to subflow')).not.toBeInTheDocument();
  });
});
