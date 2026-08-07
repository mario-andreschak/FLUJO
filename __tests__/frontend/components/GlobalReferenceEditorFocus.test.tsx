import React, { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import GlobalReferenceEditor from '@/frontend/components/shared/GlobalReferenceEditor';

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key, tp: (key: string) => key }),
}));

/**
 * Controlled harness mirroring how the chat composer drives the editor: the
 * parent owns the text and clears it on "send".
 */
const Harness = ({ initial = '' }: { initial?: string }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setValue('')}>clear</button>
      <span data-testid="value">{JSON.stringify(value)}</span>
      <GlobalReferenceEditor value={value} onChange={setValue} ariaLabel="composer" placeholder="Type…" />
    </>
  );
};

const flushFrames = async () => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

describe('GlobalReferenceEditor focus handling', () => {
  it('keeps DOM focus when the value is replaced from outside (composer clearing after send)', async () => {
    render(<Harness initial="hello world" />);
    const editable = screen.getByLabelText('composer');

    act(() => { editable.focus(); });
    expect(document.activeElement).toBe(editable);

    // Simulate the parent clearing the text the way handleSend does.
    act(() => { screen.getByText('clear').click(); });
    await flushFrames();

    expect(screen.getByTestId('value')).toHaveTextContent('""');
    expect(document.activeElement).toBe(editable);
  });

  it('does not steal focus when the value changes while the editor is not focused', async () => {
    render(<Harness initial="hello world" />);
    const editable = screen.getByLabelText('composer');
    expect(document.activeElement).not.toBe(editable);

    act(() => { screen.getByText('clear').click(); });
    await flushFrames();

    expect(document.activeElement).not.toBe(editable);
  });

  it('focuses the editable when the click lands on the frame padding around the text', () => {
    render(<Harness />);
    const editable = screen.getByLabelText('composer');
    const frame = document.querySelector('.global-reference-editor') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(document.activeElement).not.toBe(editable);

    act(() => {
      frame.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(editable);
  });
});
