"use client";

// This file allows us to explicitly mark the transformers library imports as client-side only
// and ensures proper module loading

import React, { useEffect, useState } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/services/transcription/client');

export function useTransformersAvailability() {
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only run in browser
    if (typeof window === 'undefined') return;

    async function checkAvailability() {
      setIsLoading(true);
      try {
        const { pipeline } = await import('@xenova/transformers');
        setIsAvailable(true);
        log.debug('Transformers library is available');
      } catch (err) {
        log.error('Error loading transformers library:', err);
        setError(`Failed to load transformers library: ${err}`);
        setIsAvailable(false);
      } finally {
        setIsLoading(false);
      }
    }

    checkAvailability();
  }, []);

  return { isAvailable, isLoading, error };
}

// Can be used to preload the transformers library
export function TransformersPreloader() {
  const { isAvailable, isLoading, error } = useTransformersAvailability();

  return (
    <>
      {/* This component doesn't render anything visible,
          it just ensures the library is loaded */}
    </>
  );
}