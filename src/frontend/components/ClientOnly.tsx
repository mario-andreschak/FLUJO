"use client";

import type { ReactNode } from 'react';
import { useHydrated } from '@/frontend/hooks/useBrowserValue';

interface ClientOnlyProps {
  children: ReactNode;
}

/**
 * Component that only renders its children on the client side.
 * This helps prevent hydration mismatches for components that use browser-only APIs.
 */
export default function ClientOnly({ children }: ClientOnlyProps) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <>{children}</>;
}
