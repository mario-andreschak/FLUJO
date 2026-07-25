/**
 * CaptureFields (issue #203, Phase 3 of #186) — the shared "Data-flow capture"
 * editor used by the process- and subflow-node property modals. Verifies the
 * three fields render, edits are reported through onChange, the kv scope value
 * is reflected, and the optional insert buttons emit the correct
 * ${var:}/${res:}/${kv:} tokens and are gated by validity.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CaptureFields, { CaptureFieldsValue } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/shared/CaptureFields';

const baseValue: CaptureFieldsValue = {
  captureVariable: '',
  captureResource: '',
  captureKvScope: 'folder',
  captureKvKey: '',
};

describe('CaptureFields', () => {
  it('renders the three capture fields', () => {
    render(<CaptureFields value={baseValue} onChange={() => {}} />);
    expect(screen.getByLabelText(/Capture as run variable/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Capture as run resource/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Capture as persistent key/i)).toBeInTheDocument();
  });

  it('reports edits to the variable field through onChange', () => {
    const onChange = jest.fn();
    render(<CaptureFields value={baseValue} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Capture as run variable/i), {
      target: { value: 'greeting' },
    });
    expect(onChange).toHaveBeenCalledWith({ captureVariable: 'greeting' });
  });

  it('does NOT render insert buttons when onInsertRef is omitted', () => {
    render(<CaptureFields value={baseValue} onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /Insert/i })).not.toBeInTheDocument();
  });

  it('enables the var insert button for a valid name and emits ${var:NAME}', () => {
    const onInsertRef = jest.fn();
    render(
      <CaptureFields
        value={{ ...baseValue, captureVariable: 'greeting' }}
        onChange={() => {}}
        onInsertRef={onInsertRef}
      />,
    );
    const btn = screen.getByRole('button', { name: /\$\{var:NAME\}/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onInsertRef).toHaveBeenCalledWith('${var:greeting}');
  });

  it('disables the var insert button for an invalid name', () => {
    render(
      <CaptureFields
        value={{ ...baseValue, captureVariable: '1 bad name' }}
        onChange={() => {}}
        onInsertRef={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /\$\{var:NAME\}/ })).toBeDisabled();
  });

  it('emits ${kv:NAME} with the bare key (no scope prefix) from the insert button', () => {
    const onInsertRef = jest.fn();
    render(
      <CaptureFields
        value={{ ...baseValue, captureKvScope: 'flow', captureKvKey: 'cursor' }}
        onChange={() => {}}
        onInsertRef={onInsertRef}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /\$\{kv:NAME\}/ }));
    expect(onInsertRef).toHaveBeenCalledWith('${kv:cursor}');
  });
});
