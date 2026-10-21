import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import OAuthCredentialsEditor from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/OAuthCredentialsEditor';
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ globalEnvVars: {} }) }));

it('shows the verified Slack issuer without requiring a configuration edit', () => {
  render(<OAuthCredentialsEditor serverUrl="https://mcp.slack.com/mcp" clientId="client" clientSecret="********"
    onClientIdChange={jest.fn()} onClientSecretChange={jest.fn()} />);
  expect(screen.getByLabelText('mcp.local.oauth.issuer')).toHaveValue('https://mcp.slack.com');
  expect(screen.getByText('mcp.local.oauth.issuerAutomatic')).toBeVisible();
});

it('lets users supply another provider issuer in the form while preserving the masked secret', () => {
  const change = jest.fn();
  const secret = jest.fn();
  render(<OAuthCredentialsEditor serverUrl="https://mcp.example.test/mcp" clientId="client" clientSecret="********"
    issuer="https://auth.example.test" onIssuerChange={change} onClientIdChange={jest.fn()} onClientSecretChange={secret} />);
  const input = screen.getByLabelText('mcp.local.oauth.issuer');
  expect(input).toHaveValue('https://auth.example.test');
  fireEvent.change(input, { target: { value: 'https://auth.example.test/tenant' } });
  expect(change).toHaveBeenCalledWith('https://auth.example.test/tenant');
  expect(secret).not.toHaveBeenCalled();
});
