/**
 * Ask FLUJO runs on Quick Chat, so its button must go away with the Quick Chat switch.
 * It appears in the top bar and in dialog headers, and a click would otherwise do nothing.
 */
import { render, screen } from '@testing-library/react';
import AskFlujoButton from '@/frontend/components/AskFlujo/AskFlujoButton';

let mockSettings: { modelAccess?: { quickChat?: boolean } } = {};
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: mockSettings }),
}));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: () => ({ open: false, toggleDock: jest.fn() }),
}));

describe('AskFlujoButton', () => {
  it('shows when nothing has been set', () => {
    mockSettings = {};
    render(<AskFlujoButton />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('shows when Quick Chat is on', () => {
    mockSettings = { modelAccess: { quickChat: true } };
    render(<AskFlujoButton />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('is gone when Quick Chat is off', () => {
    mockSettings = { modelAccess: { quickChat: false } };
    render(<AskFlujoButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps working when the switch changes while it is on screen', () => {
    mockSettings = { modelAccess: { quickChat: true } };
    const { rerender } = render(<AskFlujoButton />);
    mockSettings = { modelAccess: { quickChat: false } };
    rerender(<AskFlujoButton />);
    expect(screen.queryByRole('button')).toBeNull();
    mockSettings = { modelAccess: { quickChat: true } };
    rerender(<AskFlujoButton />);
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
