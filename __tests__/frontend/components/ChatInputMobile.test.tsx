import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  return { ...actual, useMediaQuery: () => true };
});

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: {}, globalEnvVars: {} }),
}));

jest.mock('@/frontend/components/shared/GlobalReferenceEditor', () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
    placeholder,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    ariaLabel: string;
    disabled?: boolean;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

jest.mock('@/frontend/components/Chat/FlowNodePicker', () => ({
  __esModule: true,
  default: () => null,
}));

import ChatInput from '@/frontend/components/Chat/ChatInput';

describe('ChatInput phone layout', () => {
  it('moves advanced run controls into a bottom sheet', async () => {
    const onRequireApprovalChange = jest.fn();
    const onExecuteInDebuggerChange = jest.fn();

    render(
      <ChatInput
        onSendMessage={() => undefined}
        onRequireApprovalChange={onRequireApprovalChange}
        onExecuteInDebuggerChange={onExecuteInDebuggerChange}
      />,
    );

    expect(screen.queryByText('Require tool approvals')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run options' }));

    const sheet = await screen.findByRole('dialog', { name: 'Run options' });
    expect(within(sheet).getByText('Require tool approvals')).toBeInTheDocument();
    expect(within(sheet).getByText('Run in debugger')).toBeInTheDocument();

    fireEvent.click(within(sheet).getByLabelText('Require tool approvals'));
    expect(onRequireApprovalChange).toHaveBeenCalledWith(true);
  });
});
