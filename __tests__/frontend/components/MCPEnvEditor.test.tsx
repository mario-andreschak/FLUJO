import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EnvEditor from '@/frontend/components/mcp/MCPEnvManager/EnvEditor';
import { MASKED_STRING } from '@/shared/types/constants';

jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ globalEnvVars: {} }) }));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const initialEnv = {
  GITHUB_TOKEN: { value: 'encrypted:synthetic-ciphertext', metadata: { isSecret: true } },
  COUNT: { value: '0', metadata: { isSecret: false } },
};

it('includes an unchanged secret mask in the replacement env map when another field changes', async () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(<EnvEditor serverName="github-test" initialEnv={initialEnv} onSave={onSave} />);
  fireEvent.change(screen.getByDisplayValue('0'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'mcp.env.save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({
    GITHUB_TOKEN: { value: MASKED_STRING, metadata: { isSecret: true } },
    COUNT: { value: '1', metadata: { isSecret: false } },
  }));
});

it('omits a deleted secret row so the backend can remove it', async () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(<EnvEditor serverName="github-test" initialEnv={initialEnv} onSave={onSave} />);
  fireEvent.click(screen.getAllByTitle('mcp.env.remove')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'mcp.env.save' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ COUNT: initialEnv.COUNT }));
});
