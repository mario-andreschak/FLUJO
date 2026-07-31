"use client";

import React, { Suspense } from 'react';
import dynamic from 'next/dynamic';
import LivingWorldGate from './AmbientWorld/LivingWorldGate';
import RouteStage from './shared/RouteStage';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/AppWrapper');

function AppLoading({ label = 'Preparing your workspace', compact = false }: { label?: string; compact?: boolean }) {
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
  loading: () => <AppLoading label="Lighting up FLUJO" />
});

const StorageProvider = dynamic(() => import('../contexts/StorageContext').then(mod => mod.StorageProvider), {
  ssr: false,
  loading: () => <AppLoading label="Opening your workspace" />
});

const Navigation = dynamic(() => import("./Navigation"), {
  ssr: false,
  loading: () => <AppLoading label="Loading navigation" compact />
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
              The workspace hit a snag
            </h2>
            <p style={{ margin: '0 auto 24px', maxWidth: 380, color: 'var(--text-secondary)' }}>
              Your data is safe. Reload FLUJO to reconnect the interface to the local runtime.
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
              Reload workspace
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface AppWrapperProps {
  children: React.ReactNode;
}

export default function AppWrapper({ children }: AppWrapperProps) {
  log.debug('Rendering AppWrapper');
  return (
    <ErrorBoundary>
      <Suspense fallback={<AppLoading />}>
        <ThemeProvider>
          <StorageProvider>
            <TourProvider>
              <div className="app-shell">
                <a className="skip-link" href="#main-content">Skip to content</a>
                <LivingWorldGate />
                <Suspense fallback={<AppLoading label="Loading navigation" compact />}>
                  <Navigation />
                  <EncryptionAuthDialog />
                  <TelemetryNotice />
                </Suspense>
                <main id="main-content" className="app-main" tabIndex={-1}>
                  <RouteStage>{children}</RouteStage>
                </main>
                <TourOverlay />
              </div>
            </TourProvider>
          </StorageProvider>
        </ThemeProvider>
      </Suspense>
    </ErrorBoundary>
  );
}
