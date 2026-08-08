"use client";

import React, { Suspense } from 'react';
import dynamic from 'next/dynamic';
import LivingWorldGate from './AmbientWorld/LivingWorldGate';
import RouteStage from './shared/RouteStage';
import { createLogger } from '@/utils/logger';
import { I18nProvider, useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import useCompactAppChrome from '@/frontend/hooks/useCompactAppChrome';
import { AskFlujoProvider } from '@/frontend/contexts/AskFlujoContext';

const log = createLogger('frontend/components/AppWrapper');

function AppLoading({ message = 'shell.loading.preparing', compact = false }: { message?: TranslationKey; compact?: boolean }) {
  const { t } = useI18n();
  const label = t(message);
  if (compact) {
    return (
      <div
        aria-label={label}
        style={{
          height: 'var(--app-bar-height)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-glass)',
          backdropFilter: 'blur(20px)',
        }}
      />
    );
  }

  return (
    <div className="app-loading" role="status" aria-live="polite">
      <div className="app-loading__content">
        <div className="app-loading__mark" aria-hidden="true"><span>F</span></div>
        <span>{label}</span>
      </div>
    </div>
  );
}

// Dynamically import components with loading fallbacks
const ThemeProvider = dynamic(() => import('../contexts/ThemeContext').then(mod => mod.ThemeProvider), {
  ssr: false,
  loading: () => <AppLoading message="shell.loading.theme" />
});

const StorageProvider = dynamic(() => import('../contexts/StorageContext').then(mod => mod.StorageProvider), {
  ssr: false,
  loading: () => <AppLoading message="shell.loading.workspace" />
});

const Navigation = dynamic(() => import("./Navigation"), {
  ssr: false,
  loading: () => <AppLoading message="shell.loading.navigation" compact />
});

const EncryptionAuthDialog = dynamic(() => import("./EncryptionAuthDialog"), {
  ssr: false,
  loading: () => null
});

const TourProvider = dynamic(() => import('../contexts/TourContext').then(mod => mod.TourProvider), {
  ssr: false,
  loading: () => null
});

const TourOverlay = dynamic(() => import('./Tour/TourOverlay'), {
  ssr: false,
  loading: () => null
});

const TelemetryNotice = dynamic(() => import('./TelemetryNotice'), {
  ssr: false,
  loading: () => null
});

const AskFlujoDock = dynamic(() => import('./AskFlujo/AskFlujoDock'), {
  ssr: false,
  loading: () => null,
});

const GlobalMcpAppsHost = dynamic(() => import('./mcp/GlobalMcpAppsHost'), {
  ssr: false,
  loading: () => null,
});

// Error boundary component to catch chunk loading errors
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: any) {
    log.error('AppWrapper error boundary caught an error:', error);
  }

  render() {
    if (this.state.hasError) {
      return <AppErrorFallback />;
    }

    return this.props.children;
  }
}

function AppErrorFallback() {
  const { t } = useI18n();
  return (
    <div className="app-loading">
      <div
        className="premium-surface"
        style={{
          width: 'min(92vw, 520px)',
          padding: '42px',
          borderRadius: '28px',
          textAlign: 'center',
        }}
      >
        <div className="app-loading__mark" style={{ margin: '0 auto 24px' }} aria-hidden="true">
          <span>!</span>
        </div>
        <h2 style={{ margin: '0 0 10px', letterSpacing: '-0.035em' }}>
          {t('shell.error.title')}
        </h2>
        <p style={{ margin: '0 auto 24px', maxWidth: 380, color: 'var(--text-secondary)' }}>
          {t('shell.error.body')}
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            minHeight: 46,
            padding: '0 22px',
            border: 0,
            borderRadius: 14,
            cursor: 'pointer',
            color: '#fff',
            background: 'linear-gradient(135deg, #9b8cff, #6253e8 55%, #18b8d7)',
            boxShadow: '0 14px 34px rgba(102, 87, 245, 0.32)',
            fontWeight: 700,
          }}
        >
          {t('shell.error.reload')}
        </button>
      </div>
    </div>
  );
}

interface AppWrapperProps {
  children: React.ReactNode;
}

export default function AppWrapper({ children }: AppWrapperProps) {
  log.debug('Rendering AppWrapper');
  return (
    <I18nProvider>
      <ErrorBoundary>
        <Suspense fallback={<AppLoading />}>
          <ThemeProvider>
            <StorageProvider>
              <AskFlujoProvider>
                <TourProvider>
                  <LocalizedAppShell>
                    {children}
                  </LocalizedAppShell>
                </TourProvider>
              </AskFlujoProvider>
            </StorageProvider>
          </ThemeProvider>
        </Suspense>
      </ErrorBoundary>
    </I18nProvider>
  );
}

function LocalizedAppShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  useCompactAppChrome();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('shell.skipToContent')}</a>
      <LivingWorldGate />
      <Suspense fallback={<AppLoading message="shell.loading.navigation" compact />}>
        <Navigation />
        <EncryptionAuthDialog />
        <TelemetryNotice />
        <AskFlujoDock />
      </Suspense>
      <main id="main-content" className="app-main" tabIndex={-1}>
        <RouteStage>{children}</RouteStage>
      </main>
      {/* Persistent owner for Quick Actions MCP Apps. It remains mounted across
          route changes, so a live iframe/bridge is never reparented or lost. */}
      <GlobalMcpAppsHost />
      <TourOverlay />
    </div>
  );
}
