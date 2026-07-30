import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EnvEditor from '@/frontend/components/mcp/MCPEnvManager/EnvEditor';
import HeadersEditor from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/LocalServerTab/HeadersEditor';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    globalEnvVars: {
      GITHUB_TOKEN: {
        value: 'encrypted:not-exposed',
        metadata: { isSecret: true },
      },
    },
  }),
}));

describe('MCP config global bindings', () => {
  it('recognizes a directly typed env ${global:NAME} binding and saves it verbatim', async () => {
    const onSave = jest.fn(async () => undefined);
    render(
      <EnvEditor
        serverName="github"
        initialEnv={{
          GITHUB_TOKEN: {
            value: '',
            metadata: { isSecret: true },
          },
        }}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Value'), {
      target: { value: '${global:GITHUB_TOKEN}' },
    });

    expect(screen.getByText('Bound to global: GITHUB_TOKEN')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      GITHUB_TOKEN: {
        value: '${global:GITHUB_TOKEN}',
        metadata: { isSecret: true },
      },
    }));
  });

  it('recognizes a directly typed header ${global:NAME} binding and emits it verbatim', () => {
    const onChange = jest.fn();
    render(<HeadersEditor headers={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Header' }));
    fireEvent.change(screen.getByLabelText('Header'), {
      target: { value: 'Authorization' },
    });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: '${global:GITHUB_TOKEN}' },
    });

    expect(screen.getByText('Bound: GITHUB_TOKEN')).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({
      Authorization: {
        value: '${global:GITHUB_TOKEN}',
        metadata: { isSecret: true },
      },
    });
  });
});
