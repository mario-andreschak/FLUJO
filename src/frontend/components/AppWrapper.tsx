"use client";

import React, { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/AppWrapper');

// Dynamically import components with loading fallbacks
const ThemeProvider = dynamic(() => import('../contexts/ThemeContext').then(mod => mod.ThemeProvider), {
  ssr: false,
  loading: () => <div>Loading theme...</div>
});

const StorageProvider = dynamic(() => import('../contexts/StorageContext').then(mod => mod.StorageProvider), {
  ssr: false,
  loading: () => <div>Loading storage...</div>
});

const Navigation = dynamic(() => import("./Navigation"), {
  ssr: false,
  loading: () => <div>Loading navigation...</div>
});

const EncryptionAuthDialog = dynamic(() => import("./EncryptionAuthDialog"), {
  ssr: false,
  loading: () => null
});

// Lazily load the TransformersPreloader only in the browser
const TransformersPreloader = dynamic(
  () => import('../services/transcription/client').then(mod => mod.TransformersPreloader),
  {
    ssr: false,
    loading: () => null
  }
);

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
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <h2>Something went wrong loading the application.</h2>
          <p>Please try refreshing the page.</p>
          <button 
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              background: '#3498DB',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginTop: '10px'
            }}
          >
            Refresh
          </button>
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
      <Suspense fallback={<div>Loading application...</div>}>
        <ThemeProvider>
          <StorageProvider>
            <Suspense fallback={<div>Loading navigation...</div>}>
              <Navigation />
              <EncryptionAuthDialog />
            </Suspense>
            <main>
              {children}
            </main>
          </StorageProvider>
        </ThemeProvider>
      </Suspense>
    </ErrorBoundary>
  );
}
