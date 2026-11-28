import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NodePalette } from '@/frontend/components/Flow/FlowManager/FlowBuilder/NodePalette';

describe('NodePalette', () => {
  it('keeps guided mode focused on the one beginner-safe AI action', () => {
    render(<NodePalette authoringMode="guided" />);

    expect(screen.getByText('Ask AI')).toBeInTheDocument();
    expect(screen.queryByText('Use a connected app')).not.toBeInTheDocument();
    expect(screen.queryByText('Send the answer')).not.toBeInTheDocument();
  });

  it('continues to show all node types in advanced mode', () => {
    render(<NodePalette authoringMode="advanced" />);

    expect(screen.getByText('Ask AI')).toBeInTheDocument();
    expect(screen.getByText('Use a connected app')).toBeInTheDocument();
    expect(screen.getByText('Use saved information')).toBeInTheDocument();
    expect(screen.getByText('Notify an automation')).toBeInTheDocument();
    expect(screen.getByText('Start automatically')).toBeInTheDocument();
    expect(screen.getByText('Ask a person')).toBeInTheDocument();
  });

  it('adds a Human step from the advanced list', () => {
    const onAddNode = jest.fn();
    render(<NodePalette authoringMode="advanced" onAddNode={onAddNode} />);

    fireEvent.click(screen.getByRole('button', { name: /Ask a person:/i }));

    expect(onAddNode).toHaveBeenCalledWith('human');
  });

  it('adds a node with one click through the explicit builder callback', () => {
    const onAddNode = jest.fn();
    render(<NodePalette authoringMode="guided" onAddNode={onAddNode} />);

    fireEvent.click(screen.getByRole('button', { name: /Ask AI:/i }));

    expect(onAddNode).toHaveBeenCalledWith('process');
    expect(onAddNode).toHaveBeenCalledTimes(1);
  });

  it('filters the add rail without hiding advanced-mode semantics', () => {
    render(<NodePalette authoringMode="advanced" />);

    fireEvent.change(screen.getByLabelText('Search actions to add'), { target: { value: 'automatically' } });

    expect(screen.getByText('Start automatically')).toBeInTheDocument();
    expect(screen.queryByText('Ask AI')).not.toBeInTheDocument();
    expect(screen.queryByText('Use a connected app')).not.toBeInTheDocument();
  });

  it('focuses quick add from the builder keyboard command', () => {
    render(<NodePalette authoringMode="guided" />);

    act(() => {
      document.dispatchEvent(new CustomEvent('openFlowQuickAdd'));
    });

    expect(screen.getByLabelText('Search actions to add')).toHaveFocus();
  });

  const startDrag = () => {
    const setDragImage = jest.fn();
    const item = screen.getByRole('button', { name: /Ask AI:/i });
    fireEvent.dragStart(item, { dataTransfer: { setData: jest.fn(), setDragImage, effectAllowed: '' } });
    return { item, preview: setDragImage.mock.calls[0][0] as HTMLElement };
  };

  it('keeps the drag picture off-screen in the page until the drag ends', () => {
    render(<NodePalette authoringMode="guided" />);

    const { item, preview } = startDrag();
    expect(preview).toHaveTextContent('Ask AI');
    expect(preview.isConnected).toBe(true);
    expect(preview.style.top).toBe('-1000px');

    fireEvent.dragEnd(item);
    expect(preview.isConnected).toBe(false);
  });

  it('replaces the drag picture on the next drag and removes it when the palette closes', () => {
    const view = render(<NodePalette authoringMode="guided" />);

    const first = startDrag().preview;
    const second = startDrag().preview;
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);

    view.unmount();
    expect(second.isConnected).toBe(false);
  });
});
