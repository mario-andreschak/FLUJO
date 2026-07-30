import React from 'react';
import { render, screen } from '@testing-library/react';
import { NodePalette } from '@/frontend/components/Flow/FlowManager/FlowBuilder/NodePalette';

describe('NodePalette', () => {
  it('shows MCP nodes in guided mode', () => {
    render(<NodePalette authoringMode="guided" />);

    expect(screen.getByText('MCP Node')).toBeInTheDocument();
    expect(screen.queryByText('Resource Node')).not.toBeInTheDocument();
  });

  it('continues to show all node types in advanced mode', () => {
    render(<NodePalette authoringMode="advanced" />);

    expect(screen.getByText('MCP Node')).toBeInTheDocument();
    expect(screen.getByText('Resource Node')).toBeInTheDocument();
    expect(screen.getByText('Signal Node')).toBeInTheDocument();
    expect(screen.getByText('Trigger Node')).toBeInTheDocument();
  });
});
