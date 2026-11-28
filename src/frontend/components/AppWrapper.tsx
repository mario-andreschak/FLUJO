"use client";

import React, { Suspense, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import LivingWorldGate from './AmbientWorld/LivingWorldGate';
import { HealAfterChunkFailure, isChunkLoadError, lazyEssential, lazyOptional } from '@/frontend/lazy';
import RouteStage from './shared/RouteStage';
import { createLogger } from '@/utils/logger';
import { I18nProvider, useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import useCompactAppChrome from '@/frontend/hooks/useCompactAppChrome';
import { AskFlujoProvider } from '@/frontend/contexts/AskFlujoContext';
import WorkspaceBootstrap from './WorkspaceBootstrap';
import { AllowanceProvider } from '@/frontend/contexts/AllowanceContext';
import PhoneHostBoundary from './PhoneHostBoundary';
import AvatarPanelBridge from './AvatarWorld/AvatarPanelBridge';
import './AvatarWorld/embed.css';

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

const ThemeProvider = lazyEssential(() => import('../contexts/ThemeContext').then(mod => mod.ThemeProvider), {
  name: 'ThemeProvider',
  loading: () => <AppLoading message="shell.loading.theme" />,
});

const StorageProvider = lazyEssential(() => import('../contexts/StorageContext').then(mod => mod.StorageProvider), {
  name: 'StorageProvider',
  loading: () => <AppLoading message="shell.loading.workspace" />,
});

const Navigation = lazyEssential(() => import('./Navigation'), {
  name: 'Navigation',
  loading: () => <AppLoading message="shell.loading.navigation" compact />,
});

const TourProvider = lazyEssential(() => import('../contexts/TourContext').then(mod => mod.TourProvider), {
  name: 'TourProvider',
  loading: () => null,
});

const EncryptionAuthDialog = lazyOptional(() => import('./EncryptionAuthDialog'), { name: 'EncryptionAuthDialog' });
const TourOverlay = lazyOptional(() => import('./Tour/TourOverlay'), { name: 'TourOverlay' });
const TelemetryNotice = lazyOptional(() => import('./TelemetryNotice'), { name: 'TelemetryNotice' });
const BigTutorialOverlay = lazyOptional(() => import('./Tour/BigTutorialOverlay'), { name: 'BigTutorialOverlay' });
const AskFlujoDock = lazyOptional(() => import('./AskFlujo/AskFlujoDock'), { name: 'AskFlujoDock' });
const GlobalMcpAppsHost = lazyOptional(() => import('./mcp/GlobalMcpAppsHost'), { name: 'GlobalMcpAppsHost' });

interface ErrorBoundaryState {
  failure: { error: unknown } | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failure: { error } };
  }

  componentDidCatch(error: unknown) {
    log.error('AppWrapper error boundary caught an error:', error);
  }

  private healed = () => {
    log.info('The workspace loaded again after a chunk failed to load');
    this.setState({ failure: null });
  };

  render() {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    return (
      <>
        <AppErrorFallback />
        {isChunkLoadError(failure.error) && <HealAfterChunkFailure onHealed={this.healed} />}
      </>
    );
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
  phoneHost?: boolean;
}

export default function AppWrapper({ children, phoneHost = false }: AppWrapperProps) {
  const pathname = usePathname();
  // Sign-in must render before workspace/storage providers make protected requests.
  if (pathname === '/owner/login') return <>{children}</>;
  log.debug('Rendering AppWrapper');
  return (
    <I18nProvider>
      <ErrorBoundary>
        <Suspense fallback={<AppLoading />}>
          <PhoneHostBoundary enabled={phoneHost} fallback={<AppLoading message="shell.loading.workspace" />}>
          <WorkspaceBootstrap fallback={<AppLoading message="shell.loading.workspace" />}>
            <ThemeProvider>
              <StorageProvider>
                <AllowanceProvider>
                <AskFlujoProvider>
                  <TourProvider>
                    <LocalizedAppShell>
                      {children}
                    </LocalizedAppShell>
                  </TourProvider>
                </AskFlujoProvider>
                </AllowanceProvider>
              </StorageProvider>
            </ThemeProvider>
          </WorkspaceBootstrap>
          </PhoneHostBoundary>
        </Suspense>
      </ErrorBoundary>
    </I18nProvider>
  );
}

function LocalizedAppShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [embedded, setEmbedded] = useState(false);
  const world = pathname === '/world';
  useEffect(() => {
    setEmbedded(window.frameElement?.getAttribute('data-flujo-avatar-panel') === 'true');
  }, []);
  useCompactAppChrome();

  return (
    <div className={`app-shell ${world ? 'avatar-world-shell' : ''} ${embedded ? 'avatar-panel-shell' : ''}`}>
      <Link
        className="skip-link"
        href="#main-content"
        replace
        onNavigate={() => document.getElementById('main-content')?.focus()}
      >
        {t('shell.skipToContent')}
      </Link>
      {!world && !embedded && <LivingWorldGate />}
      <Suspense fallback={<AppLoading message="shell.loading.navigation" compact />}>
        {!world && !embedded && <Navigation />}
        <EncryptionAuthDialog />
        {!world && !embedded && <TelemetryNotice />}
        {!world && !embedded && <AskFlujoDock />}
      </Suspense>
      {embedded && <AvatarPanelBridge />}
      <main id="main-content" className="app-main" tabIndex={-1}>
        <RouteStage>{children}</RouteStage>
      </main>
      {/* Persistent owner for Quick Actions MCP Apps. It remains mounted across
          route changes, so a live iframe/bridge is never reparented or lost. */}
      <GlobalMcpAppsHost />
      {!world && !embedded && <TourOverlay />}
      {!world && !embedded && <BigTutorialOverlay />}
    </div>
  );
}
