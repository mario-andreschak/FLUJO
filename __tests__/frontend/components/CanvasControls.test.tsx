import React from 'react';
import { render, screen } from '@testing-library/react';
import { CanvasControls } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/components/CanvasControls';

jest.mock('@xyflow/react', () => ({
  Background: () => <div data-testid="canvas-background" />,
  Controls: () => <div data-testid="react-flow-controls" />,
  MiniMap: () => <div data-testid="canvas-minimap" />,
}));

jest.mock('@mui/material/styles', () => ({
  useTheme: () => ({
    palette: {
      mode: 'light',
      divider: '#ddd',
      text: { disabled: '#999' },
      primary: { dark: '#123', light: '#abc' },
    },
  }),
}));

describe('CanvasControls', () => {
  it('renders one React Flow navigation control family with the background and minimap', () => {
    render(<CanvasControls />);

    expect(screen.getAllByTestId('react-flow-controls')).toHaveLength(1);
    expect(screen.getByTestId('canvas-background')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-minimap')).toBeInTheDocument();
  });
});
