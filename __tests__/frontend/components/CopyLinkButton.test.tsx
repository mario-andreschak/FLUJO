/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
import CopyLinkButton from '@/frontend/components/shared/CopyLinkButton';

const writeText = jest.fn();
const execCommand = jest.fn();

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
});

beforeEach(() => {
  jest.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  execCommand.mockReset().mockReturnValue(false);
});

afterEach(() => {
  jest.useRealTimers();
});

async function clickButton() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

it('shows "Link copied" and goes back to "Copy link" after 1.5 seconds', async () => {
  render(<CopyLinkButton target={{ kind: 'flow', id: 'flow-1' }} />);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();

  await clickButton();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/flows?flow=flow-1'));
  expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();

  advance(1499);
  expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
  advance(1);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
});

it('starts the 1.5 seconds again when the link is copied again', async () => {
  render(<CopyLinkButton target={{ kind: 'flow', id: 'flow-1' }} />);
  await clickButton();
  advance(1000);
  await clickButton();

  advance(1000);
  expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
  advance(500);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
});

it('clears the failure message after the same delay and keeps a custom idle label', async () => {
  writeText.mockRejectedValue(new Error('denied'));
  render(<CopyLinkButton target={{ kind: 'model', id: 'model-1' }} label="Copy link to this page" />);

  await clickButton();
  expect(screen.getByRole('button', { name: 'Could not copy link' })).toBeInTheDocument();

  advance(1499);
  expect(screen.getByRole('button', { name: 'Could not copy link' })).toBeInTheDocument();
  advance(1);
  expect(screen.getByRole('button', { name: 'Copy link to this page' })).toBeInTheDocument();
});
