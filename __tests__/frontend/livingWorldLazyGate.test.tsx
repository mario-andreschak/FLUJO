/** @jest-environment jsdom */

import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import LivingWorldGate from '@/frontend/components/AmbientWorld/LivingWorldGate';

const mockTheme = {
  livingWorldEnabled: true,
  themeHydrated: true,
  visualStyle: 'modern' as 'modern' | 'legacy',
};

jest.mock('next/dynamic', () => {
  const dynamicRiverWorldStub = jest.fn(() => <div data-living-world-stub />);
  return {
    __esModule: true,
    default: () => dynamicRiverWorldStub,
    dynamicRiverWorldStub,
  };
});

jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => mockTheme,
}));

const { dynamicRiverWorldStub: mockDynamicRiverWorld } = jest.requireMock('next/dynamic') as {
  dynamicRiverWorldStub: jest.Mock;
};

describe('Living Watershed lazy gate', () => {
  afterEach(() => {
    cleanup();
    mockDynamicRiverWorld.mockClear();
    mockTheme.livingWorldEnabled = true;
    mockTheme.themeHydrated = true;
    mockTheme.visualStyle = 'modern';
  });

  it('does not mount the dynamic renderer before the theme hydrates', () => {
    mockTheme.themeHydrated = false;

    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('does not mount the dynamic renderer when the landscape preference is off', () => {
    mockTheme.livingWorldEnabled = false;

    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('does not mount the dynamic renderer for the legacy visual style', () => {
    mockTheme.visualStyle = 'legacy';

    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('mounts the dynamic renderer for the default-on hydrated Modern theme', () => {
    const { container } = render(<LivingWorldGate />);

    expect(container.querySelector('[data-living-world-stub]')).toBeInTheDocument();
    expect(mockDynamicRiverWorld).toHaveBeenCalledTimes(1);
  });
});
