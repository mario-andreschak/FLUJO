import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RegistryAccountSettings from '@/frontend/components/Packages/RegistryAccountSettings';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n/locales';

const getStatusMock = jest.fn();
const getSettingsMock = jest.fn();
const resendConfirmationMock = jest.fn();
const saveSettingsMock = jest.fn();

jest.mock('@/frontend/services/registry', () => ({
  registryService: {
    getStatus: (...args: unknown[]) => getStatusMock(...args),
    getSettings: (...args: unknown[]) => getSettingsMock(...args),
    resendConfirmation: (...args: unknown[]) => resendConfirmationMock(...args),
    saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
  },
}));

beforeEach(() => {
  jest.resetAllMocks();
  window.localStorage.clear();
  getStatusMock.mockResolvedValue({
    signedIn: false, email: 'new@example.com', isConfirmed: false, hasToken: false,
  });
  getSettingsMock.mockResolvedValue({
    defaultUrl: 'https://catalogue.example.com', usingDefault: true, baseUrl: 'https://catalogue.example.com',
  });
});

afterEach(() => window.localStorage.clear());

describe.each([
  {
    locale: 'en', resend: 'Resend confirmation email', resendFailed: 'Failed to resend confirmation.',
    sent: 'Confirmation email sent.', save: 'Save', saveFailed: 'Failed to save.', saved: 'Registry URL saved.',
  },
  {
    locale: 'es', resend: 'Reenviar correo de confirmación', resendFailed: 'No se pudo reenviar la confirmación.',
    sent: 'Correo de confirmación enviado.', save: 'Guardar', saveFailed: 'No se pudo guardar.', saved: 'URL del registro guardada.',
  },
])('catalogue account recovery in $locale', (copy) => {
  beforeEach(() => window.localStorage.setItem(LOCALE_STORAGE_KEY, copy.locale));

  test('a failed confirmation request keeps the account visible and can be retried', async () => {
    let rejectRequest!: (cause: Error) => void;
    resendConfirmationMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectRequest = reject;
    })).mockResolvedValueOnce({ success: true });

    render(<I18nProvider><RegistryAccountSettings /></I18nProvider>);
    const button = await screen.findByRole('button', { name: copy.resend });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => rejectRequest(new TypeError('Failed to fetch')));

    expect(await screen.findByText(copy.resendFailed)).toBeInTheDocument();
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText(copy.sent)).toBeInTheDocument();
    expect(screen.queryByText(copy.resendFailed)).not.toBeInTheDocument();
    expect(resendConfirmationMock).toHaveBeenCalledTimes(2);
  });

  test('a failed save retains the edited address and can be retried', async () => {
    let rejectRequest!: (cause: Error) => void;
    saveSettingsMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectRequest = reject;
    })).mockResolvedValueOnce({ success: true });

    render(<I18nProvider><RegistryAccountSettings /></I18nProvider>);
    const button = await screen.findByRole('button', { name: copy.save });
    const address = screen.getByPlaceholderText('https://catalogue.example.com');
    fireEvent.change(address, { target: { value: 'https://my-catalogue.example.com' } });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => rejectRequest(new TypeError('Failed to fetch')));

    expect(await screen.findByText(copy.saveFailed)).toBeInTheDocument();
    expect(address).toHaveValue('https://my-catalogue.example.com');
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await screen.findByText(copy.saved)).toBeInTheDocument();
    expect(screen.queryByText(copy.saveFailed)).not.toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    expect(saveSettingsMock).toHaveBeenNthCalledWith(1, 'https://my-catalogue.example.com');
    expect(saveSettingsMock).toHaveBeenNthCalledWith(2, 'https://my-catalogue.example.com');
  });
});
