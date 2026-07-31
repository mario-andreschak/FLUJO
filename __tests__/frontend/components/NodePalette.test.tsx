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
});
