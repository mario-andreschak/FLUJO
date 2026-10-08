import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, useI18n } from '@/frontend/contexts/I18nContext';
import { LOCALE_STORAGE_KEY } from '@/frontend/i18n';

function LocaleProbe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span>{locale}</span>
      <span>{t('settings.title')}</span>
      <button onClick={() => setLocale('zh-CN')}>中文</button>
    </div>
  );
}

describe('I18nProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'en';
    delete document.documentElement.dataset.locale;
  });

  it('restores the saved locale and synchronizes the document language', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'es');
    render(<I18nProvider><LocaleProbe /></I18nProvider>);

    expect(await screen.findByText('Configuración')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('es'));
    expect(document.documentElement.dataset.locale).toBe('es');
  });

  it('changes language immediately and persists the preference', async () => {
    render(<I18nProvider><LocaleProbe /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '中文' }));

    expect(await screen.findByText('设置')).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
  });
});
