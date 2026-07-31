/** @jest-environment jsdom */

import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import LivingWorldGate from '@/frontend/components/AmbientWorld/LivingWorldGate';

const mockStorage = {
  settings: { experimental: { enabled: false } },
  settingsHydrated: true,
};

const mockTheme = {
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

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorage,
}));

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
    mockStorage.settings.experimental.enabled = false;
    mockStorage.settingsHydrated = true;
    mockTheme.visualStyle = 'modern';
  });

  it('does not mount the dynamic renderer before settings hydrate', () => {
    mockStorage.settings.experimental.enabled = true;
    mockStorage.settingsHydrated = false;

    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('does not mount the dynamic renderer for the default disabled state', () => {
    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('does not mount the dynamic renderer for the legacy visual style', () => {
    mockStorage.settings.experimental.enabled = true;
    mockTheme.visualStyle = 'legacy';

    const { container } = render(<LivingWorldGate />);

    expect(container).toBeEmptyDOMElement();
    expect(mockDynamicRiverWorld).not.toHaveBeenCalled();
  });

  it('mounts the dynamic renderer only for hydrated Modern experiments', () => {
    mockStorage.settings.experimental.enabled = true;

    const { container } = render(<LivingWorldGate />);

    expect(container.querySelector('[data-living-world-stub]')).toBeInTheDocument();
    expect(mockDynamicRiverWorld).toHaveBeenCalledTimes(1);
  });
});
