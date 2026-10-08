import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import Chat from '@/frontend/components/Chat';
import { I18nProvider } from '@/frontend/contexts/I18nContext';
import { StorageProvider } from '@/frontend/contexts/StorageContext';
import { AskFlujoProvider } from '@/frontend/contexts/AskFlujoContext';

// Supply the framework context normally supplied by Next. Chat, its children,
// providers, services, state, effects, and fetch transport are actual Source.
const router = {
  back: () => history.back(), forward: () => history.forward(), refresh: () => location.reload(),
  push: (url: string) => history.pushState(null, '', url),
  replace: (url: string) => history.replaceState(null, '', url), prefetch: async () => undefined,
};
const root = createRoot(document.getElementById('root')!);
root.render(
  <AppRouterContext.Provider value={router}>
    <PathnameContext.Provider value="/chat">
      <ThemeProvider theme={createTheme()}>
        <I18nProvider><StorageProvider><AskFlujoProvider><Chat /></AskFlujoProvider></StorageProvider></I18nProvider>
      </ThemeProvider>
    </PathnameContext.Provider>
  </AppRouterContext.Provider>,
);
(window as unknown as { unmountChat: () => void }).unmountChat = () => root.unmount();
