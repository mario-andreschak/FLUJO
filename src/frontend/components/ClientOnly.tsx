"use client";

import { useEffect, useState, ReactNode } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/ClientOnly');

interface ClientOnlyProps {
  children: ReactNode;
}

/**
 * Component that only renders its children on the client side.
 * This helps prevent hydration mismatches for components that use browser-only APIs.
 */
export default function ClientOnly({ children }: ClientOnlyProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    log.debug('ClientOnly component mounted');
    setIsMounted(true);
    return () => {
      log.debug('ClientOnly component unmounted');
    };
  }, []);

  if (!isMounted) {
    log.debug('ClientOnly component rendering null (not yet mounted)');
    return null;
  }

  log.debug('ClientOnly component rendering children');
  return <>{children}</>;
}
